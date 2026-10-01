/**
 * Wired media pipeline — integration examples
 * ===========================================
 *
 * Feature: media-engine-lag — Task 10.2
 * Validates: Requirements 2.5-2.8, 3.5-3.12, 5.4-5.8, 6.1-6.10, 7.2-7.6
 *
 * What is under test
 * ------------------
 * The REAL `FastMedia` entry points from js/core/fastMediaEngine.js
 * (`init`, the ExtendScript picker path into `importFolder`, background stage
 * completion, and `dispose`) driving the REAL production runtime they wire up:
 * the REAL bounded scheduler (js/core/scheduler.js), the REAL
 * `MediaEntryRepository` (js/core/persistence.js), the REAL
 * `KeyedMediaCardHelper` (js/core/keyedMediaCardHelper.js) over the REAL shared
 * card markup (js/templates/templates.js), the REAL `MediaScenarioMetrics`
 * recorder (js/core/observability.js) and the REAL `HoverPreviewController`.
 *
 * Only the environment is faked — never the pipeline:
 *   • an asynchronous in-memory filesystem (streams included),
 *   • `child_process.execFile` for FFmpeg,
 *   • the parsed DOM from tests/helpers/miniDom.js,
 *   • media elements (`<video>`, `<canvas>`, `Image`),
 *   • timers and animation frames,
 *   • the ExtendScript bridge (`csInterface.evalScript`).
 *
 * There is no running CEP panel and no product file is modified.
 *
 * These are examples, not properties. Generated coverage of the same code lives
 * in tests/optimistic-card-placeholder.property.test.js (Property 3),
 * tests/performance/media-import-batch.property.test.js (Properties 4-5),
 * tests/performance/fast-media-terminal-regression.test.js (Properties 8, 10),
 * tests/media-index-migration.property.test.js (Properties 16-19, 22, 24) and
 * tests/media-hover-controller.property.test.js (Properties 20-21).
 */

"use strict";

const nodeFs = require("fs");
const nodePath = require("path");
const vm = require("vm");

const {
    MediaEntryRepository,
    LibraryIndex,
    deriveCombinedValidityKeyAsync,
} = require("../js/core/persistence.js");
const { KeyedMediaCardHelper } = require("../js/core/keyedMediaCardHelper.js");
const schedulerModule = require("../js/core/scheduler.js");
const { loadHelpers } = require("./helpers/loadHelpers.js");
const { createMiniDocument, MiniElement } = require("./helpers/miniDom.js");

const ROOT = nodePath.resolve(__dirname, "..");
const ENGINE_SCRIPT = new vm.Script(nodeFs.readFileSync(nodePath.join(ROOT, "js/core/fastMediaEngine.js"), "utf8"), {
    filename: "fastMediaEngine.js",
});
const OBSERVABILITY_SCRIPT = new vm.Script(nodeFs.readFileSync(nodePath.join(ROOT, "js/core/observability.js"), "utf8"), {
    filename: "observability.js",
});

const LIBRARY_ROOT = "C:/library";
const SOURCE_FOLDER = "C:/originals/mixed";
const FFMPEG_EXECUTABLE = "C:/tools/ffmpeg.exe";
const SOURCE_FILES = ["still-a.png", "still-b.jpg", "clip-a.mp4", "clip-b.mov", "notes.txt"];
const SUPPORTED_COUNT = 4;

// ─── The real shared single-card markup (browser module, no module system) ────
const constants = loadHelpers({ file: nodePath.join("js", "core", "constants.js") });
const utils = loadHelpers({
    file: nodePath.join("js", "core", "utils.js"),
    injected: {
        SECTIONS: constants.get("SECTIONS"),
        IMAGE_SECTIONS: constants.get("IMAGE_SECTIONS"),
    },
});
const templates = loadHelpers({
    file: nodePath.join("js", "templates", "templates.js"),
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
    throw new Error("Task 10.2 requires renderTemplateCardMarkup from js/templates/templates.js");
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment fakes
// ─────────────────────────────────────────────────────────────────────────────

// Asynchronous in-memory disk. Promise APIs, callback APIs (used by the
// validity-key derivation) and read/write streams; no synchronous API at all.
function createFakeDisk() {
    const nodes = {};
    const calls = [];

    function canon(value) {
        return String(value === undefined || value === null ? "" : value).replace(/\\/g, "/").replace(/\/+$/, "");
    }
    function keyOf(value) { return canon(value).toLowerCase(); }
    function link(childPath) {
        const child = canon(childPath);
        const at = child.lastIndexOf("/");
        if (at <= 1) return;
        const parent = addDirectory(child.substring(0, at));
        const name = child.substring(at + 1);
        if (parent && parent.children.indexOf(name) === -1) parent.children.push(name);
    }
    function addDirectory(target) {
        const canonical = canon(target);
        if (!canonical) return null;
        let node = nodes[keyOf(canonical)];
        if (!node) {
            node = nodes[keyOf(canonical)] = { dir: true, path: canonical, children: [] };
            link(canonical);
        }
        return node;
    }
    function addFile(target, size) {
        const canonical = canon(target);
        const node = { dir: false, path: canonical, children: [], size: Number(size) >= 0 ? Number(size) : 0, mtimeMs: 1000 };
        nodes[keyOf(canonical)] = node;
        link(canonical);
        return node;
    }
    function statsFor(node) {
        return {
            size: node.dir ? 0 : node.size,
            mtimeMs: node.dir ? 500 : node.mtimeMs,
            isDirectory: function () { return node.dir === true; },
            isFile: function () { return node.dir !== true; },
        };
    }
    function record(call, target) { calls.push({ call: call, target: canon(target) }); }

    const promises = {
        mkdir: function (target) {
            record("mkdir", target);
            addDirectory(target);
            return Promise.resolve();
        },
        stat: function (target) {
            record("stat", target);
            const node = nodes[keyOf(target)];
            return node ? Promise.resolve(statsFor(node)) : Promise.reject(new Error("ENOENT: " + target));
        },
        readdir: function (target) {
            record("readdir", target);
            const node = nodes[keyOf(target)];
            if (!node || !node.dir) return Promise.reject(new Error("ENOTDIR: " + target));
            return Promise.resolve(node.children.slice());
        },
        writeFile: function (target, data) {
            record("writeFile", target);
            addFile(target, String(data === undefined || data === null ? "" : data).length);
            return Promise.resolve();
        },
        unlink: function (target) {
            record("unlink", target);
            delete nodes[keyOf(target)];
            return Promise.resolve();
        },
    };

    function createReadStream(source) {
        const handlers = {};
        const stream = {
            on: function (event, handler) { handlers[event] = handler; return stream; },
            destroy: function () { stream.destroyed = true; return stream; },
            pipe: function (writer) {
                record("copy-stream", source);
                Promise.resolve().then(function () {
                    const node = nodes[keyOf(source)];
                    if (!node || node.dir) {
                        if (handlers.error) handlers.error(new Error("ENOENT: " + source));
                        return;
                    }
                    addFile(writer.target, node.size);
                    writer.emitClose();
                });
                return writer;
            },
        };
        return stream;
    }
    function createWriteStream(target) {
        const handlers = {};
        const writer = {
            target: canon(target),
            on: function (event, handler) { handlers[event] = handler; return writer; },
            destroy: function () { writer.destroyed = true; return writer; },
            emitClose: function () { if (handlers.close) handlers.close(); },
        };
        return writer;
    }

    return {
        calls: calls,
        addDirectory: addDirectory,
        addFile: addFile,
        writeFile: function (target, data) { return addFile(target, String(data || "").length); },
        exists: function (target) { return !!nodes[keyOf(target)]; },
        sizeOf: function (target) { const node = nodes[keyOf(target)]; return node ? node.size : -1; },
        countOf: function (call) { return calls.filter(function (entry) { return entry.call === call; }).length; },
        fs: {
            promises: promises,
            createReadStream: createReadStream,
            createWriteStream: createWriteStream,
            // Callback APIs used by the asynchronous validity-key derivation.
            stat: function (target, callback) {
                promises.stat(target).then(function (stats) { callback(null, stats); }, function (error) { callback(error); });
            },
            readdir: function (target, callback) {
                promises.readdir(target).then(function (names) { callback(null, names); }, function (error) { callback(error); });
            },
        },
    };
}

// A disk whose every use is a failure: any call would be the full library scan
// a Warm_Startup must not perform.
function createStrictDisk() {
    const calls = [];
    function refuse(name) {
        return function () {
            calls.push(name);
            throw new Error("warm startup must not call fs." + name);
        };
    }
    return {
        calls: calls,
        fs: {
            promises: {
                mkdir: refuse("promises.mkdir"), stat: refuse("promises.stat"), readdir: refuse("promises.readdir"),
                writeFile: refuse("promises.writeFile"), unlink: refuse("promises.unlink"), readFile: refuse("promises.readFile"),
            },
            createReadStream: refuse("createReadStream"),
            createWriteStream: refuse("createWriteStream"),
            stat: refuse("stat"), readdir: refuse("readdir"), readFile: refuse("readFile"),
            existsSync: refuse("existsSync"), statSync: refuse("statSync"), readdirSync: refuse("readdirSync"),
        },
    };
}

// FFmpeg through a fake `child_process`: every run is recorded, produces its
// output artifact, and can be killed.
function createFakeChildProcesses(disk) {
    const runs = [];
    const children = [];
    function execFile(executable, args, options, callback) {
        const output = String(args[args.length - 1]);
        const child = {
            pid: children.length + 1,
            killed: false,
            exited: false,
            kill: function () { child.killed = true; child.exited = true; return true; },
        };
        runs.push({ executable: executable, args: args, output: output, child: child });
        children.push(child);
        Promise.resolve().then(function () {
            if (child.killed) return;
            disk.writeFile(output, "MEDIA-DERIVATIVE");
            child.exited = true;
            if (typeof callback === "function") callback(null, "", "");
        });
        return child;
    }
    return {
        module: { execFile: execFile },
        runs: runs,
        children: children,
        live: function () { return children.filter(function (child) { return !child.exited && !child.killed; }).length; },
    };
}

// Virtual clock for every timer the engine owns (hover intent/activation,
// decode and FFmpeg timeouts, batch progress, scheduler deferrals).
function createClock() {
    const timers = {};
    let next = 1;
    let now = 0;
    return {
        now: function () { return now; },
        pending: function () { return Object.keys(timers).length; },
        set: function (callback, delay) {
            const id = next++;
            timers[id] = { at: now + Math.max(0, Number(delay) || 0), callback: callback };
            return id;
        },
        clear: function (id) { delete timers[id]; },
        advance: function (ms) {
            const target = now + Math.max(0, Number(ms) || 0);
            for (let guard = 0; guard < 500; guard++) {
                let dueId = null;
                Object.keys(timers).forEach(function (id) {
                    if (timers[id].at > target) return;
                    if (dueId === null || timers[id].at < timers[dueId].at) dueId = id;
                });
                if (dueId === null) break;
                const due = timers[dueId];
                delete timers[dueId];
                now = due.at;
                due.callback();
            }
            now = target;
        },
    };
}

function createFrameQueue() {
    let queue = [];
    let next = 1;
    const state = { flushes: 0, requests: 0 };
    return {
        state: state,
        pending: function () { return queue.length; },
        request: function (callback) {
            const handle = next++;
            state.requests++;
            queue.push({ handle: handle, callback: callback });
            return handle;
        },
        cancel: function (handle) {
            queue = queue.filter(function (entry) { return entry.handle !== handle; });
        },
        drain: function () {
            const due = queue;
            queue = [];
            for (let i = 0; i < due.length; i++) {
                state.flushes++;
                due[i].callback(0);
            }
        },
    };
}

// Media elements. A decode probe (`crossOrigin = "anonymous"`, set by the
// thumbnail worker) reports frames or a codec error; the hover controller's
// reusable element plays instead. `.mov` models the residual codec that has to
// fall through to the FFmpeg lane.
function createMediaElements(options) {
    options = options || {};
    const decodeFail = options.decodeFailPattern || /\.mov$/i;
    const registry = {
        videos: [],
        decodeVideos: [],
        hoverVideos: [],
        canvases: [],
        images: [],
        playCalls: [],
    };

    registry.attach = function (element) {
        const handlers = {};
        let src = "";
        let currentTime = 0;
        element.duration = 4;
        element.videoWidth = 1920;
        element.videoHeight = 1080;
        element.addEventListener = function (type, listener) {
            (handlers[type] = handlers[type] || []).push(listener);
        };
        element.removeEventListener = function (type, listener) {
            const list = handlers[type] || [];
            const at = list.indexOf(listener);
            if (at !== -1) list.splice(at, 1);
        };
        element.emit = function (type) {
            (handlers[type] || []).slice().forEach(function (listener) { listener({ type: type, target: element }); });
        };
        element.listenerCount = function () {
            return Object.keys(handlers).reduce(function (total, type) { return total + handlers[type].length; }, 0);
        };
        element.load = function () { element.loadCount = (element.loadCount || 0) + 1; };
        element.pause = function () { element.paused = true; };
        element.play = function () {
            registry.playCalls.push({ element: element, src: src });
            return Promise.resolve().then(function () { element.emit("playing"); });
        };
        Object.defineProperty(element, "src", {
            configurable: true,
            get: function () { return src; },
            set: function (value) {
                src = String(value === undefined || value === null ? "" : value);
                element.activeSrc = src;
                if (!src) return;
                if (element.crossOrigin === "anonymous") {
                    if (registry.decodeVideos.indexOf(element) === -1) registry.decodeVideos.push(element);
                    const probed = src;
                    Promise.resolve().then(function () {
                        if (element.activeSrc !== probed) return;
                        element.emit(decodeFail.test(probed) ? "error" : "loadeddata");
                    });
                    return;
                }
                if (registry.hoverVideos.indexOf(element) === -1) registry.hoverVideos.push(element);
            },
        });
        Object.defineProperty(element, "currentTime", {
            configurable: true,
            get: function () { return currentTime; },
            set: function (value) {
                currentTime = Number(value) || 0;
                Promise.resolve().then(function () { if (element.activeSrc) element.emit("seeked"); });
            },
        });
        registry.videos.push(element);
        return element;
    };

    registry.createCanvas = function () {
        const context = {
            fillStyle: "", font: "", textAlign: "",
            drawImage: function () { }, fillRect: function () { }, beginPath: function () { },
            moveTo: function () { }, lineTo: function () { }, closePath: function () { },
            fill: function () { }, fillText: function () { },
        };
        const canvas = {
            width: 0,
            height: 0,
            getContext: function () { return context; },
            toDataURL: function () {
                canvas.encodedAt = { width: canvas.width, height: canvas.height };
                registry.encoded.push({ width: canvas.width, height: canvas.height });
                return "data:image/png;base64,TUVESUE=";
            },
        };
        registry.canvases.push(canvas);
        return canvas;
    };
    registry.encoded = [];

    registry.Image = function ImageFake() {
        const image = this;
        let src = "";
        image.naturalWidth = 1600;
        image.naturalHeight = 900;
        image.onload = null;
        image.onerror = null;
        Object.defineProperty(image, "src", {
            configurable: true,
            get: function () { return src; },
            set: function (value) {
                src = String(value === undefined || value === null ? "" : value);
                if (!src) return;
                Promise.resolve().then(function () {
                    if (image.src !== src) return;
                    if (typeof image.onload === "function") image.onload({ type: "load", target: image });
                });
            },
        });
        registry.images.push(image);
    };

    // A decoder is active while an element holds a source and is attached.
    registry.activeDecoders = function () {
        return registry.videos.filter(function (video) { return !!video.activeSrc && !!video.parentNode; }).length;
    };
    return registry;
}

// The parsed DOM plus the event surface a panel document provides.
function createPanelDocument(media) {
    const document = createMiniDocument();
    const createRaw = document.createElement;
    const listeners = {};
    document.addEventListener = function (type, listener) {
        (listeners[type] = listeners[type] || []).push(listener);
    };
    document.removeEventListener = function (type, listener) {
        const list = listeners[type] || [];
        const at = list.indexOf(listener);
        if (at !== -1) list.splice(at, 1);
    };
    document.dispatch = function (type, event) {
        (listeners[type] || []).slice().forEach(function (listener) { listener(event); });
    };
    document.listenerCount = function (type) {
        if (type) return (listeners[type] || []).length;
        return Object.keys(listeners).reduce(function (total, key) { return total + listeners[key].length; }, 0);
    };
    document.createElement = function (tagName) {
        const name = String(tagName).toLowerCase();
        if (name === "canvas") return media.createCanvas();
        const element = createRaw.call(document, name);
        if (name === "video") media.attach(element);
        return element;
    };
    return document;
}

function createPanelButton(document, id) {
    const button = document.createElement("div");
    const handlers = {};
    button.setAttribute("id", id);
    button.addEventListener = function (type, listener) { (handlers[type] = handlers[type] || []).push(listener); };
    button.removeEventListener = function (type, listener) {
        const list = handlers[type] || [];
        const at = list.indexOf(listener);
        if (at !== -1) list.splice(at, 1);
    };
    button.handlerCount = function (type) { return (handlers[type || "click"] || []).length; };
    button.click = function () {
        (handlers.click || []).slice().forEach(function (listener) {
            listener({ type: "click", target: button, stopPropagation: function () { } });
        });
    };
    document.body.appendChild(button);
    return button;
}

// ─────────────────────────────────────────────────────────────────────────────
// The panel realm: real engine, real runtime collaborators, faked environment
// ─────────────────────────────────────────────────────────────────────────────

function createPanel(options) {
    options = options || {};
    const disk = options.disk || createFakeDisk();
    const childProcesses = createFakeChildProcesses(disk.writeFile ? disk : createFakeDisk());
    const clock = createClock();
    const frames = createFrameQueue();
    const media = createMediaElements({});
    const document = createPanelDocument(media);

    const grid = document.createElement("div");
    grid.setAttribute("id", "footage-list-container");
    grid.className = "card-grid";
    document.body.appendChild(grid);
    const buttons = {
        file: createPanelButton(document, "btn-import-file"),
        folder: createPanelButton(document, "btn-import-folder"),
    };

    // Real bounded scheduler, observed (not replaced) at the admission boundary.
    const scheduler = schedulerModule.createScheduler({ setTimeout: clock.set, clearTimeout: clock.clear });
    const admissions = [];
    const observedScheduler = Object.create(scheduler);
    observedScheduler.enqueue = function (lane, worker, enqueueOptions) {
        enqueueOptions = enqueueOptions || {};
        admissions.push({
            lane: lane,
            stage: enqueueOptions.stage,
            mediaId: enqueueOptions.mediaId,
            owner: enqueueOptions.owner,
            cardsAtAdmission: grid.children.length,
        });
        return scheduler.enqueue(lane, worker, enqueueOptions);
    };

    // Real repository; only the storage sink is a fake.
    const storage = { writes: [], last: null };
    function RepositoryFactory(repositoryOptions) {
        const merged = {};
        Object.keys(repositoryOptions || {}).forEach(function (key) { merged[key] = repositoryOptions[key]; });
        merged.persist = function (serialized) {
            storage.writes.push(serialized);
            storage.last = serialized;
        };
        return new MediaEntryRepository(merged);
    }

    // Real keyed card helper; every keyed operation is recorded.
    const cardPatches = [];
    const cardInsertions = [];
    const cardFailures = [];
    function CardsFactory(cardOptions) {
        const merged = {};
        Object.keys(cardOptions || {}).forEach(function (key) { merged[key] = cardOptions[key]; });
        merged.onFailedUpdate = function (reason) { cardFailures.push(reason); };
        const helper = new KeyedMediaCardHelper(merged);
        const realPatch = helper.patchById;
        const realInsert = helper.insertBatch;
        helper.patchById = function (id, patch) {
            const result = realPatch.call(helper, id, patch);
            cardPatches.push({ id: id, patch: patch, ok: !!(result && result.ok) });
            return result;
        };
        helper.insertBatch = function (entries, target) {
            const before = target && target.children ? target.children.length : -1;
            const result = realInsert.call(helper, entries, target);
            cardInsertions.push({ count: entries.length, before: before, ok: !!(result && result.ok) });
            return result;
        };
        return helper;
    }

    const index = options.index || new LibraryIndex({ validityKey: null });
    const mirror = options.entries ? JSON.parse(JSON.stringify(options.entries)) : [];
    const toasts = [];
    const bridge = {
        scripts: [],
        result: options.pickerResult === undefined ? "" : options.pickerResult,
        evalScript: function (script, callback) {
            bridge.scripts.push(script);
            Promise.resolve().then(function () { callback(bridge.result); });
        },
    };
    const refreshes = { categoryTabs: 0, categoryPanel: 0, counts: 0 };
    const scenarioEvents = [];

    const context = {
        document: document,
        performance: { now: function () { return Date.now(); } },
        console: { log: function () { }, warn: function () { }, error: function () { } },
        require: function (name) {
            if (name === "fs") return disk.fs;
            if (name === "path") return nodePath;
            if (name === "child_process") return childProcesses.module;
            throw new Error("Unexpected require: " + name);
        },
        setTimeout: clock.set,
        clearTimeout: clock.clear,
        setInterval: clock.set,
        clearInterval: clock.clear,
        Promise: Promise,
        Date: Date,
        Buffer: Buffer,
        encodeURIComponent: encodeURIComponent,
        decodeURI: decodeURI,
        unescape: function (value) { return value; },
        btoa: function () { return ""; },
        csInterface: bridge,
        currentSection: "footage",
        showToast: function (message, kind) { toasts.push({ message: message, kind: kind }); },
        getLibraryIndex: function () { return index; },
        buildCategoryTabs: function () { refreshes.categoryTabs++; },
        buildCategoryPanel: function () { refreshes.categoryPanel++; },
        updateCount: function () { refreshes.counts++; },
    };
    context.Image = media.Image;
    context.window = {
        rootPath: LIBRARY_ROOT,
        libraryPaths: [LIBRARY_ROOT],
        allTemplates: mirror,
        document: document,
        performance: context.performance,
        Scheduler: observedScheduler,
        MediaEntryRepository: RepositoryFactory,
        KeyedMediaCardHelper: CardsFactory,
        renderTemplateCardMarkup: renderTemplateCardMarkup,
        requestAnimationFrame: frames.request,
        cancelAnimationFrame: frames.cancel,
        URL: { createObjectURL: function () { return "blob:media"; }, revokeObjectURL: function () { } },
        resolveFfmpeg: function (callback) { callback(options.ffmpegAvailable === false ? "" : FFMPEG_EXECUTABLE); },
        __COMP_SAVER_MEDIA_INSTRUMENTATION__: true,
        addEventListener: function () { },
        removeEventListener: function () { },
    };
    context.window.window = context.window;
    context.Scheduler = observedScheduler;

    vm.createContext(context);
    OBSERVABILITY_SCRIPT.runInContext(context);
    context.window.PerfEvents.subscribe(function (event) { scenarioEvents.push(event); });
    ENGINE_SCRIPT.runInContext(context);
    if (!context.window.FastMedia || typeof context.window.FastMedia.init !== "function") {
        throw new Error("FastMedia entry points were not exposed by the media engine");
    }

    return {
        engine: context.window,
        FastMedia: context.window.FastMedia,
        disk: disk,
        childProcesses: childProcesses,
        clock: clock,
        frames: frames,
        media: media,
        document: document,
        grid: grid,
        buttons: buttons,
        scheduler: scheduler,
        admissions: admissions,
        storage: storage,
        index: index,
        mirror: mirror,
        cardPatches: cardPatches,
        cardInsertions: cardInsertions,
        cardFailures: cardFailures,
        toasts: toasts,
        bridge: bridge,
        refreshes: refreshes,
        scenarioEvents: scenarioEvents,
        cardsFactory: CardsFactory,
        stagesFor: function (mediaId) {
            return admissions.filter(function (entry) { return entry.mediaId === mediaId; })
                .map(function (entry) { return entry.stage; });
        },
    };
}

// One panel turn: drain the animation frames a live panel would paint, then let
// pending asynchronous work advance.
function turn(panel) {
    panel.frames.drain();
    return new Promise(function (resolve) { setImmediate(resolve); });
}

async function flush(panel, turns) {
    for (let i = 0; i < (turns || 1); i++) await turn(panel);
}

async function waitFor(panel, predicate, label, attempts) {
    const limit = attempts || 600;
    for (let i = 0; i < limit; i++) {
        if (predicate()) return true;
        await turn(panel);
    }
    throw new Error("timed out waiting for " + label);
}

function entriesByKind(panel) {
    const durable = JSON.parse(JSON.stringify(panel.mirror));
    const imported = durable.filter(function (entry) { return entry.category === IMPORT_CATEGORY; });
    return {
        all: durable,
        imported: imported,
        images: imported.filter(function (entry) { return entry.mediaType === "image"; }),
        videos: imported.filter(function (entry) { return entry.mediaType === "video"; }),
        mov: imported.filter(function (entry) { return /\.mov$/i.test(entry.mainFile || ""); })[0] || null,
        mp4: imported.filter(function (entry) { return /\.mp4$/i.test(entry.mainFile || ""); })[0] || null,
    };
}

function classTokens(card) {
    return String(card.className || "").split(/\s+/).filter(function (token) { return !!token; });
}

function countByCategory(entries) {
    const counts = {};
    for (let i = 0; i < entries.length; i++) {
        const key = entries[i] && entries[i].category !== undefined ? String(entries[i].category) : "";
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
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

function legacyEntry(position, category) {
    return {
        id: "legacy-" + position,
        name: "legacy-" + position,
        category: category,
        section: "footage",
        type: "media",
        mediaType: "video",
        folderPath: LIBRARY_ROOT + "/footage/legacy/" + position,
        sourcePath: "C:/archive/legacy-" + position + ".mp4",
        mainFile: "legacy-" + position + ".mp4",
        thumbStatus: "ready",
        terminalState: "ready",
        _isPending: false,
    };
}

const IMPORT_CATEGORY = "mixed"; // folder import categorizes by folder name

// Drive the real entry points: FastMedia.init(), the panel's import-folder
// button, the ExtendScript bridge, then background completion to idle.
async function runMixedBatchPanel(options) {
    options = options || {};
    const disk = createFakeDisk();
    disk.addDirectory(LIBRARY_ROOT);
    disk.addDirectory(SOURCE_FOLDER);
    SOURCE_FILES.forEach(function (name, position) { disk.addFile(SOURCE_FOLDER + "/" + name, 4096 + position); });

    const existing = options.existing || [];
    const index = new LibraryIndex({ validityKey: null });
    index._entries = JSON.parse(JSON.stringify(existing));

    const panel = createPanel({
        disk: disk,
        index: index,
        // The picker returns a native path with backslashes.
        pickerResult: "C:\\originals\\mixed",
    });
    panel.gridWatch = watchFullGridReplacement(panel.grid);
    panel.existing = JSON.parse(JSON.stringify(existing));

    if (panel.FastMedia.init() !== true) throw new Error("FastMedia.init() did not wire the panel");
    panel.buttons.folder.click();

    await waitFor(panel, function () {
        const imported = panel.mirror.filter(function (entry) { return entry.category === IMPORT_CATEGORY; });
        return imported.length === SUPPORTED_COUNT && imported.every(function (entry) {
            return entry._isPending === false;
        });
    }, "every imported item to settle");
    // Let the post-idle validity refresh commit before the index is inspected.
    await waitFor(panel, function () {
        try { return typeof JSON.parse(panel.storage.last).validityKey === "string"; } catch (error) { return false; }
    }, "the post-idle validity refresh");
    await flush(panel, 4);
    return panel;
}

// ─────────────────────────────────────────────────────────────────────────────
// One coherent panel session: picker → optimistic cards → background stages →
// hover preview → panel disposal
// ─────────────────────────────────────────────────────────────────────────────

describe("a mixed media batch through the wired FastMedia pipeline", function () {
    let panel = null;
    let kinds = null;
    let beforeDisposal = null;

    beforeAll(async function () {
        panel = await runMixedBatchPanel({ existing: [legacyEntry(1, "Alpha"), legacyEntry(2, "Beta")] });
        kinds = entriesByKind(panel);
    });

    afterAll(function () {
        if (panel) panel.FastMedia.dispose();
        panel = null;
    });

    test("the picker inserts every optimistic card, commits once, and coalesces refreshes (Req 2.5, 2.6, 2.8, 7.4)", function () {
        // The ExtendScript bridge was the only host interaction.
        expect(panel.bridge.scripts.length).toBe(1);
        expect(panel.bridge.scripts[0]).toContain("Folder.selectDialog");

        // One keyed batch insertion for all four accepted files, and it happened
        // against an empty grid (no per-file grid rebuild).
        expect(panel.cardInsertions.length).toBe(1);
        expect(panel.cardInsertions[0]).toEqual({ count: SUPPORTED_COUNT, before: 0, ok: true });
        expect(panel.grid.children.length).toBe(SUPPORTED_COUNT);
        expect(panel.gridWatch.assignments).toBe(0);

        // The first durable write is the single optimistic commit: pre-existing
        // entries retained, every imported entry still pending.
        const firstCommit = JSON.parse(panel.storage.writes[0]);
        expect(firstCommit.entries.length).toBe(SUPPORTED_COUNT + panel.existing.length);
        const optimistic = firstCommit.entries.filter(function (entry) { return entry.category === IMPORT_CATEGORY; });
        expect(optimistic.length).toBe(SUPPORTED_COUNT);
        expect(optimistic.every(function (entry) { return entry._isPending === true; })).toBe(true);
        expect(firstCommit.entries.filter(function (entry) { return /^legacy-/.test(entry.id); }).length).toBe(2);

        // Req 2.5: no background work was admitted before the cards were visible.
        expect(panel.admissions.length).toBeGreaterThanOrEqual(SUPPORTED_COUNT * 2);
        expect(panel.admissions[0].stage).toBe("copy");
        expect(panel.admissions[0].cardsAtAdmission).toBe(SUPPORTED_COUNT);

        // Req 2.8: refreshes are frame-coalesced, not one per file or per stage.
        expect(panel.frames.state.flushes).toBeGreaterThanOrEqual(1);
        expect(panel.frames.state.flushes).toBeLessThanOrEqual(3);
        expect(panel.refreshes.categoryTabs).toBeGreaterThanOrEqual(1);
        expect(panel.refreshes.categoryTabs).toBeLessThanOrEqual(3);
        expect(panel.refreshes.categoryTabs).toBeLessThan(panel.admissions.length);

        // The unsupported file never entered the pipeline.
        expect(panel.mirror.some(function (entry) { return /notes\.txt$/i.test(entry.mainFile || ""); })).toBe(false);
        expect(panel.disk.countOf("readdir")).toBeGreaterThanOrEqual(1);
    });

    test("background stages settle exactly once with one owning lane each (Req 3.5-3.12, 5.4-5.6, 7.2, 7.3)", function () {
        expect(kinds.imported.length).toBe(SUPPORTED_COUNT);
        expect(kinds.images.length).toBe(2);
        expect(kinds.videos.length).toBe(2);

        // Stage plans: images and the decodable clip stop at the thumbnail lane;
        // the residual `.mov` codec falls through to the FFmpeg lane.
        kinds.images.forEach(function (entry) {
            expect(panel.stagesFor(entry.id)).toEqual(["copy", "thumbnail"]);
        });
        expect(panel.stagesFor(kinds.mp4.id)).toEqual(["copy", "thumbnail"]);
        expect(panel.stagesFor(kinds.mov.id)).toEqual(["copy", "thumbnail", "ffmpeg"]);

        // Req 4.1-4.4: every derivative was encoded inside the 320×180 bound —
        // one image decode per still, one decode probe per clip.
        expect(panel.media.images.length).toBe(2);
        expect(panel.media.decodeVideos.length).toBe(2);
        expect(panel.media.encoded.length).toBe(SUPPORTED_COUNT);
        panel.media.encoded.forEach(function (size) {
            expect(size.width).toBeGreaterThan(0);
            expect(size.height).toBeGreaterThan(0);
            expect(size.width).toBeLessThanOrEqual(320);
            expect(size.height).toBeLessThanOrEqual(180);
        });

        const laneOfStage = {};
        panel.admissions.forEach(function (entry) { laneOfStage[entry.stage] = entry.lane; });
        expect(laneOfStage).toEqual({ copy: "filesystem", thumbnail: "thumbnail", ffmpeg: "ffmpeg" });

        // Req 3.5/3.6: exactly one terminal keyed patch per item, all successful.
        const patchedIds = panel.cardPatches.map(function (entry) { return entry.id; });
        expect(patchedIds.slice().sort()).toEqual(kinds.all
            .filter(function (entry) { return entry.category === IMPORT_CATEGORY; })
            .map(function (entry) { return entry.id; }).sort());
        panel.cardPatches.forEach(function (entry) {
            expect(entry.ok).toBe(true);
            expect(entry.patch.terminalState).toBe("ready");
            expect(entry.patch._isPending).toBe(false);
        });
        expect(panel.cardFailures).toEqual([]);

        // Req 7.2: committed media semantics survive the terminal update.
        kinds.imported.forEach(function (entry) {
            expect(entry.section).toBe("footage");
            expect(entry.terminalState).toBe("ready");
            expect(entry.derivativeStatus).toBe("available");
            expect(entry.thumbStatus).toBe("ready");
            expect(entry._isPending).toBe(false);
            expect(entry.thumbnailPath).toBe(entry.folderPath + "/thumbnail.png");
            expect(entry.mediaFile).toBe(entry.folderPath + "/" + entry.mainFile);
            expect(entry.fileSize).toBeGreaterThan(0);

            // Req 5.1/7.1: the copy landed and the original is untouched.
            expect(panel.disk.exists(entry.mediaFile)).toBe(true);
            expect(panel.disk.sizeOf(entry.mediaFile)).toBe(panel.disk.sizeOf(entry.sourcePath));
            expect(panel.disk.exists(entry.sourcePath)).toBe(true);

            const card = panel.document.getElementById("tpl-" + entry.id);
            expect(card).not.toBeNull();
            expect(card.getAttribute("data-terminalstate")).toBe("ready");
            expect(classTokens(card)).not.toContain("media-pending");
        });

        // The FFmpeg route produced the proxy and released every process handle.
        expect(kinds.mov.proxyFile).toBe(kinds.mov.folderPath + "/proxy.mp4");
        expect(kinds.mp4.proxyFile).toBeUndefined();
        expect(panel.childProcesses.runs.length).toBe(2);
        panel.childProcesses.runs.forEach(function (run) {
            expect(run.executable).toBe(FFMPEG_EXECUTABLE);
            expect(run.child.exited).toBe(true);
        });
        expect(panel.childProcesses.live()).toBe(0);

        // Req 3.12: idle means zero queued jobs, zero timers, zero processes.
        const schedulerSnapshot = panel.scheduler.snapshot();
        expect(schedulerSnapshot.active).toBe(0);
        expect(schedulerSnapshot.pending).toBe(0);
        expect(schedulerSnapshot.timers).toBe(0);
        expect(schedulerSnapshot.processes).toBe(0);
        expect(schedulerSnapshot.lanes.thumbnail.limit).toBe(1);
        expect(schedulerSnapshot.lanes.ffmpeg.limit).toBe(1);
        expect(schedulerSnapshot.lanes.filesystem.limit).toBe(2);

        // Req 2.7: aggregate membership counts are exact over the whole index.
        expect(countByCategory(panel.mirror)).toEqual({ Alpha: 1, Beta: 1, mixed: SUPPORTED_COUNT });

        // Req 1.7: exactly one aggregate scenario report for the import.
        const reports = panel.scenarioEvents.filter(function (event) { return event.name === "media.scenario"; });
        expect(reports.length).toBe(1);
        const report = reports[0].fields;
        expect(report.failedKeyedPatches).toBe(0);
        expect(report.peaks.postIdleChildProcesses).toBe(0);
        expect(report.peaks.postIdleVideoDecoders).toBe(0);
        kinds.imported.forEach(function (entry) {
            const stages = report.stages.filter(function (record) { return record.mediaId === entry.id; })
                .map(function (record) { return record.stage; });
            expect(stages).toContain("copy");
            expect(stages).toContain("thumbnail");
        });
    });

    test("hover preview on a completed video card uses one decoder and prefers the proxy (Req 6.1-6.5, 6.8)", async function () {
        const movCard = panel.document.getElementById("tpl-" + kinds.mov.id);
        const mp4Card = panel.document.getElementById("tpl-" + kinds.mp4.id);
        const ffmpegRunsBefore = panel.childProcesses.runs.length;

        panel.document.dispatch("mouseover", { type: "mouseover", target: movCard, relatedTarget: null });
        // Req 6.1: nothing decodes before the 150 ms intent delay elapses.
        expect(panel.media.activeDecoders()).toBe(0);
        panel.clock.advance(150);
        await flush(panel, 3);

        // Req 6.2/6.5: one reusable decoder, pointed at the known proxy.
        expect(panel.media.hoverVideos.length).toBe(1);
        expect(panel.media.activeDecoders()).toBe(1);
        const hoverVideo = panel.media.hoverVideos[0];
        expect(hoverVideo.src).toBe("file:///" + encodeURI(kinds.mov.proxyFile));
        expect(hoverVideo.parentNode).toBe(movCard.querySelector(".thumb-box"));
        // The static thumbnail stays in place beneath the preview.
        expect(movCard.querySelectorAll(".thumb-img").length).toBe(1);
        // Req 6.9: a card that already has a proxy queues no new FFmpeg work.
        expect(panel.childProcesses.runs.length).toBe(ffmpegRunsBefore);

        // Req 6.3/6.8: moving to another card replaces the decoder, never adds one.
        panel.document.dispatch("mouseover", { type: "mouseover", target: mp4Card, relatedTarget: null });
        panel.clock.advance(150);
        await flush(panel, 3);
        expect(panel.media.hoverVideos.length).toBe(1);
        expect(panel.media.activeDecoders()).toBe(1);
        expect(panel.media.hoverVideos[0]).toBe(hoverVideo);
        expect(hoverVideo.src).toBe("file:///" + encodeURI(kinds.mp4.mediaFile));
        expect(hoverVideo.parentNode).toBe(mp4Card.querySelector(".thumb-box"));

        // Req 6.6: leaving the card releases the decoder and leaves the thumbnail.
        panel.document.dispatch("mouseout", { type: "mouseout", target: mp4Card, relatedTarget: null });
        await flush(panel, 2);
        expect(panel.media.activeDecoders()).toBe(0);
        expect(hoverVideo.parentNode).toBe(null);
        expect(mp4Card.querySelectorAll(".thumb-img").length).toBe(1);
    });

    test("panel disposal retains commits and leaves no queued work, process, or decoder (Req 3.10-3.12, 6.6, 7.5, 7.6)", async function () {
        // Re-arm a hover so disposal has a live decoder to release.
        const movCard = panel.document.getElementById("tpl-" + kinds.mov.id);
        panel.document.dispatch("mouseover", { type: "mouseover", target: movCard, relatedTarget: null });
        panel.clock.advance(150);
        await flush(panel, 3);
        expect(panel.media.activeDecoders()).toBe(1);

        beforeDisposal = {
            entries: JSON.parse(JSON.stringify(panel.mirror)),
            serialized: panel.storage.last,
            writes: panel.storage.writes.length,
            cards: panel.grid.children.map(function (card) { return card.id; }),
        };

        expect(panel.FastMedia.dispose()).toBe(true);
        await flush(panel, 3);

        // Req 7.5: already committed entries and their cards survive disposal.
        expect(JSON.parse(JSON.stringify(panel.mirror))).toEqual(beforeDisposal.entries);
        expect(panel.storage.last).toBe(beforeDisposal.serialized);
        expect(panel.storage.writes.length).toBe(beforeDisposal.writes);
        expect(panel.grid.children.map(function (card) { return card.id; })).toEqual(beforeDisposal.cards);

        // Req 3.10/3.11/4.6: quiescent scheduler, processes and decoders.
        const snapshot = panel.scheduler.snapshot();
        expect(snapshot.active).toBe(0);
        expect(snapshot.pending).toBe(0);
        expect(snapshot.timers).toBe(0);
        expect(snapshot.processes).toBe(0);
        expect(panel.childProcesses.live()).toBe(0);
        expect(panel.media.activeDecoders()).toBe(0);
        expect(panel.media.hoverVideos[0].parentNode).toBe(null);
        expect(panel.media.hoverVideos[0].src).toBe("");
        expect(panel.media.hoverVideos[0].listenerCount()).toBe(0);

        // Listeners and admission are gone, and disposal is idempotent.
        expect(panel.document.listenerCount()).toBe(0);
        expect(panel.buttons.folder.handlerCount()).toBe(0);
        expect(panel.buttons.file.handlerCount()).toBe(0);
        expect(panel.FastMedia.dispose()).toBe(false);

        // Post-disposal hover and import are inert.
        panel.document.dispatch("mouseover", { type: "mouseover", target: movCard, relatedTarget: null });
        panel.clock.advance(200);
        await flush(panel, 2);
        expect(panel.media.activeDecoders()).toBe(0);

        const rejected = await panel.FastMedia.importFolder(SOURCE_FOLDER, "footage");
        expect(rejected.ok).toBe(false);
        expect(rejected.cancelled).toBe(true);
        expect(panel.storage.writes.length).toBe(beforeDisposal.writes);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reopening the panel from the persisted index
// ─────────────────────────────────────────────────────────────────────────────

describe("warm reopen from the persisted media index", function () {
    let warm = null;
    let closed = null;

    afterAll(function () {
        if (warm) warm.FastMedia.dispose();
        if (closed) closed.FastMedia.dispose();
        warm = null;
        closed = null;
    });

    test("the persisted index projects one card per entry with identical fields and no library scan (Req 5.4-5.8, 7.5, 7.6)", async function () {
        closed = await runMixedBatchPanel({});
        const endOfImport = JSON.parse(JSON.stringify(closed.mirror));
        const serialized = closed.storage.last;
        expect(endOfImport.length).toBe(SUPPORTED_COUNT);
        expect(typeof serialized).toBe("string");

        // The persisted index still matches the disk it was written against, so a
        // reopen needs no full scan at all.
        const currentKey = await deriveCombinedValidityKeyAsync([LIBRARY_ROOT], closed.disk.fs);
        expect(typeof currentKey).toBe("string");
        expect(LibraryIndex.fullScanRequired(serialized, currentKey)).toBe(false);
        const warmIndex = LibraryIndex.parse(serialized);
        expect(warmIndex.needsFullScan()).toBe(false);

        // Req 5.4/5.5: every field and value survived persistence losslessly.
        expect(JSON.parse(JSON.stringify(warmIndex.entries()))).toEqual(endOfImport);

        closed.FastMedia.dispose();
        closed = null;

        // Reopen: the media engine is wired against a filesystem that fails on
        // any access, so a scan would be impossible to hide.
        const strict = createStrictDisk();
        warm = createPanel({ disk: strict, index: LibraryIndex.parse(serialized), entries: warmIndex.entries() });
        expect(warm.FastMedia.init()).toBe(true);
        await flush(warm, 2);
        expect(strict.calls).toEqual([]);

        // Req 5.7/5.8: the projection is a keyed insertion, one card per entry.
        const cards = warm.cardsFactory({
            document: warm.document,
            renderCardMarkup: renderTemplateCardMarkup,
        });
        const inserted = cards.insertBatch(warm.mirror, warm.grid);
        expect(inserted.ok).toBe(true);
        expect(warm.grid.children.length).toBe(endOfImport.length);
        expect(strict.calls).toEqual([]);
        expect(warm.cardFailures).toEqual([]);

        endOfImport.forEach(function (entry) {
            const card = warm.document.getElementById("tpl-" + entry.id);
            expect(card).not.toBeNull();
            expect(card.getAttribute("data-file")).toBe(entry.name);
            expect(card.getAttribute("data-cat")).toBe(entry.category);
            expect(card.getAttribute("data-folder")).toBe(entry.folderPath);
            expect(card.getAttribute("data-mediatype")).toBe(entry.mediaType);
            expect(card.getAttribute("data-mediapath")).toBe(entry.proxyFile || entry.mediaFile);
            expect(card.getAttribute("data-thumb")).toBe("file:///" + encodeURI(entry.thumbnailPath.replace(/^\//, "")));
            expect(card.querySelectorAll(".thumb-img").length).toBe(1);
            expect(classTokens(card)).not.toContain("media-pending");
        });

        // Req 6.5/7.6: the reopened panel's hover controller resolves the
        // persisted proxy for a projected card without any filesystem access.
        const warmMov = warm.mirror.filter(function (entry) { return !!entry.proxyFile; })[0];
        expect(warmMov).toBeTruthy();
        const warmCard = warm.document.getElementById("tpl-" + warmMov.id);
        warm.document.dispatch("mouseover", { type: "mouseover", target: warmCard, relatedTarget: null });
        warm.clock.advance(150);
        await flush(warm, 3);
        expect(warm.media.hoverVideos.length).toBe(1);
        expect(warm.media.activeDecoders()).toBe(1);
        expect(warm.media.hoverVideos[0].src).toBe("file:///" + encodeURI(warmMov.proxyFile));
        expect(strict.calls).toEqual([]);

        warm.document.dispatch("mouseout", { type: "mouseout", target: warmCard, relatedTarget: null });
        await flush(warm, 2);
        expect(warm.media.activeDecoders()).toBe(0);

        cards.dispose();
    });
});
