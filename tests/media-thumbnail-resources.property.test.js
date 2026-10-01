"use strict";

/**
 * Feature: media-engine-lag
 * Bounded thumbnail generation properties for the real Fast Media stage workers.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const fc = require("fast-check");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_FILE = path.join(ROOT, "js/core/fastMediaEngine.js");

const MAX_WIDTH = 320;
const MAX_HEIGHT = 180;
const ENCODED_PNG = "data:image/png;base64,QUJDREVG";

/** Independent reference fit model, written without reading the implementation. */
function referenceFit(sourceWidth, sourceHeight) {
    const scale = Math.min(1, MAX_WIDTH / sourceWidth, MAX_HEIGHT / sourceHeight);
    return {
        scale,
        width: Math.max(1, Math.floor(sourceWidth * scale)),
        height: Math.max(1, Math.floor(sourceHeight * scale)),
    };
}

function createRecordingCanvas(ops) {
    let currentWidth = 0;
    let currentHeight = 0;
    const context = {
        fillStyle: "",
        font: "",
        textAlign: "",
        drawImage: function (source, x, y, drawWidth, drawHeight) {
            ops.push({
                op: "drawImage",
                drawWidth,
                drawHeight,
                canvasWidth: currentWidth,
                canvasHeight: currentHeight,
            });
        },
        fillRect: function () { ops.push({ op: "fillRect" }); },
        fillText: function () { ops.push({ op: "fillText" }); },
        beginPath: function () { }, moveTo: function () { }, lineTo: function () { },
        closePath: function () { }, fill: function () { },
    };
    const canvas = {
        getContext: function (kind) {
            ops.push({ op: "getContext", kind, canvasWidth: currentWidth, canvasHeight: currentHeight });
            return context;
        },
        toDataURL: function (type) {
            ops.push({ op: "toDataURL", type, canvasWidth: currentWidth, canvasHeight: currentHeight });
            return ENCODED_PNG;
        },
    };
    Object.defineProperty(canvas, "width", {
        get: function () { return currentWidth; },
        set: function (value) { currentWidth = value; ops.push({ op: "width", value }); },
    });
    Object.defineProperty(canvas, "height", {
        get: function () { return currentHeight; },
        set: function (value) { currentHeight = value; ops.push({ op: "height", value }); },
    });
    return canvas;
}

function createEventTarget() {
    const listeners = {};
    return {
        listeners,
        addEventListener: function (name, listener) {
            (listeners[name] = listeners[name] || []).push(listener);
        },
        removeEventListener: function (name, listener) {
            const bucket = listeners[name] || [];
            for (let i = bucket.length - 1; i >= 0; i--) {
                if (bucket[i] === listener) bucket.splice(i, 1);
            }
        },
        dispatch: function (name) {
            const bucket = (listeners[name] || []).slice();
            for (let i = 0; i < bucket.length; i++) bucket[i]({ type: name });
        },
    };
}

function createDecodingImage(sample) {
    const target = createEventTarget();
    const image = {
        naturalWidth: sample.width,
        naturalHeight: sample.height,
        width: sample.width,
        height: sample.height,
        onload: null,
        onerror: null,
        addEventListener: target.addEventListener,
        removeEventListener: target.removeEventListener,
    };
    let decoded = false;
    Object.defineProperty(image, "src", {
        get: function () { return image._src || ""; },
        set: function (value) {
            image._src = value;
            if (decoded || !value) return;
            decoded = true;
            target.dispatch("load");
        },
    });
    return image;
}

function createDecodingVideo(sample) {
    const target = createEventTarget();
    const video = {
        muted: false,
        crossOrigin: "",
        duration: 30,
        videoWidth: sample.width,
        videoHeight: sample.height,
        addEventListener: target.addEventListener,
        removeEventListener: target.removeEventListener,
        pause: function () { },
        load: function () { },
        removeAttribute: function () { },
        parentNode: null,
    };
    let seeked = false;
    let loaded = false;
    Object.defineProperty(video, "currentTime", {
        get: function () { return video._currentTime || 0; },
        set: function (value) {
            video._currentTime = value;
            if (seeked) return;
            seeked = true;
            target.dispatch("seeked");
        },
    });
    Object.defineProperty(video, "src", {
        get: function () { return video._src || ""; },
        set: function (value) {
            video._src = value;
            if (loaded || !value) return;
            loaded = true;
            target.dispatch("loadeddata");
        },
    });
    return video;
}

let activeRun = null;

function loadThumbnailWorkers() {
    let source = fs.readFileSync(SOURCE_FILE, "utf8");
    const expose = "\nwindow.__property11Workers = {" +
        " generateImageThumbnail: generateImageThumbnail," +
        " extractVideoFrame: extractVideoFrame };\n";
    source = source.replace(/\}\)\(window, document\);\s*$/, expose + "})(window, document);");
    if (source.indexOf("__property11Workers") === -1) {
        throw new Error("Fast Media thumbnail workers could not be exposed to the harness");
    }

    const timers = new Map();
    let timerId = 0;
    const fakeFs = {
        promises: {
            mkdir: function () { return Promise.resolve(); },
            writeFile: function (target, data, encoding) {
                if (activeRun) activeRun.fsOps.push({ op: "writeFile", target, data, encoding });
                return Promise.resolve();
            },
            copyFile: function (from, to) {
                if (activeRun) activeRun.fsOps.push({ op: "copyFile", from, to });
                return Promise.resolve();
            },
            stat: function () { return Promise.resolve({ size: 1, mtimeMs: 1 }); },
            unlink: function () { return Promise.resolve(); },
        },
        createReadStream: function () { throw new Error("thumbnail generation must not stream files"); },
        createWriteStream: function () { throw new Error("thumbnail generation must not stream files"); },
        existsSync: function () { throw new Error("thumbnail generation must not use synchronous fs"); },
        statSync: function () { throw new Error("thumbnail generation must not use synchronous fs"); },
    };

    const context = {
        window: {
            rootPath: "C:/isolated-library",
            addEventListener: function () { },
            URL: { createObjectURL: function () { return "blob:thumb"; }, revokeObjectURL: function () { } },
        },
        document: {
            createElement: function (tag) {
                if (!activeRun) throw new Error("createElement outside a property run");
                if (String(tag).toLowerCase() === "canvas") {
                    activeRun.canvas = createRecordingCanvas(activeRun.ops);
                    return activeRun.canvas;
                }
                if (String(tag).toLowerCase() === "video") {
                    activeRun.video = createDecodingVideo(activeRun.sample);
                    return activeRun.video;
                }
                throw new Error("Unexpected element requested: " + tag);
            },
            getElementById: function () { return null; },
            querySelector: function () { return null; },
            querySelectorAll: function () { return []; },
        },
        Image: function () {
            if (!activeRun) throw new Error("Image outside a property run");
            activeRun.image = createDecodingImage(activeRun.sample);
            return activeRun.image;
        },
        performance: { now: function () { return 0; } },
        console: { log: function () { }, warn: function () { }, error: function () { } },
        require: function (name) {
            if (name === "fs") return fakeFs;
            if (name === "path") return path;
            throw new Error("Unexpected require: " + name);
        },
        setTimeout: function (handler, delay) {
            timerId += 1;
            timers.set(timerId, { handler, delay });
            return timerId;
        },
        clearTimeout: function (id) { timers.delete(id); },
        setInterval: function () { return 0; },
        clearInterval: function () { },
        Promise, Date, Math, JSON, Object, Array, String, Number, Error,
        encodeURI, encodeURIComponent, decodeURIComponent,
        btoa: function () { return ""; },
        unescape: function (value) { return value; },
    };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "fastMediaEngine.js" });

    return {
        workers: context.window.__property11Workers,
        fitThumbnailDimensions: context.window.FastMedia.fitThumbnailDimensions,
        pendingTimers: timers,
    };
}

const engine = loadThumbnailWorkers();

const dimensionArbitrary = fc.oneof(
    fc.integer({ min: 1, max: 4 }),
    fc.integer({ min: 1, max: MAX_HEIGHT }),
    fc.integer({ min: 1, max: MAX_WIDTH }),
    fc.constantFrom(1, 2, 179, 180, 181, 319, 320, 321, 360, 480, 720, 1080, 1920, 2160, 3840, 7680),
    fc.integer({ min: 321, max: 20000 })
);

const thumbnailSourceArbitrary = fc.record({
    kind: fc.constantFrom("image", "video"),
    width: dimensionArbitrary,
    height: dimensionArbitrary,
});

/** Drives the real worker synchronously and returns the recorded canvas/fs operations. */
function generateThumbnail(sample) {
    const run = { sample, ops: [], fsOps: [], canvas: null, image: null, video: null };
    activeRun = run;
    try {
        const promise = sample.kind === "image"
            ? engine.workers.generateImageThumbnail("C:/source/frame.png", "C:/library/thumb.png", null)
            : engine.workers.extractVideoFrame("C:/source/clip.mp4", 1, "C:/library/thumb.png", null);
        promise.then(function () { }, function () { });
    } finally {
        activeRun = null;
    }
    engine.pendingTimers.clear();
    return run;
}

function checkBoundedThumbnail(sample) {
    const violations = [];
    const expected = referenceFit(sample.width, sample.height);
    const fitted = engine.fitThumbnailDimensions(sample.width, sample.height);
    const run = generateThumbnail(sample);
    const ops = run.ops;

    if (fitted.width !== expected.width || fitted.height !== expected.height) {
        violations.push("fit function disagrees with reference model: " +
            JSON.stringify(fitted) + " vs " + JSON.stringify(expected));
    }
    if (!(fitted.width >= 1) || !(fitted.height >= 1)) {
        violations.push("output dimensions are not positive: " + JSON.stringify(fitted));
    }
    if (fitted.width > MAX_WIDTH || fitted.height > MAX_HEIGHT) {
        violations.push("output dimensions exceed 320x180: " + JSON.stringify(fitted));
    }

    // Aspect ratio preserved within integer-rounding tolerance (cross-multiplied slack).
    const unclamped = Math.floor(sample.width * expected.scale) >= 1 &&
        Math.floor(sample.height * expected.scale) >= 1;
    if (unclamped) {
        const skew = Math.abs(fitted.width * sample.height - fitted.height * sample.width);
        if (skew > Math.max(sample.width, sample.height) + 1e-9) {
            violations.push("aspect ratio drifted beyond rounding tolerance: skew=" + skew);
        }
    } else if (fitted.width !== 1 && fitted.height !== 1) {
        violations.push("clamped dimension is not 1: " + JSON.stringify(fitted));
    }

    // A derivative must be produced instead of the original whenever a source bound is exceeded.
    const exceedsBound = sample.width > MAX_WIDTH || sample.height > MAX_HEIGHT;
    const encodedDerivative = ops.some(function (entry) { return entry.op === "toDataURL"; });
    const drewFrame = ops.filter(function (entry) { return entry.op === "drawImage"; });
    if (!encodedDerivative || drewFrame.length !== 1) {
        violations.push("thumbnail was not produced by exactly one draw plus encode: " + JSON.stringify(ops));
    }
    if (exceedsBound) {
        if (!(fitted.width < sample.width || fitted.height < sample.height) || !(expected.scale < 1)) {
            violations.push("source bound exceeded but no scaled derivative was chosen");
        }
        if (run.fsOps.some(function (entry) { return entry.op === "copyFile"; })) {
            violations.push("source file was copied instead of scaled");
        }
    }
    if (!run.fsOps.some(function (entry) {
        return entry.op === "writeFile" && entry.encoding === "base64" &&
            entry.data === ENCODED_PNG.replace(/^data:image\/png;base64,/, "");
    })) {
        violations.push("encoded canvas output was not persisted: " + JSON.stringify(run.fsOps));
    }

    // Canvas dimensions must be assigned before drawing or encoding.
    const firstDrawIndex = ops.findIndex(function (entry) { return entry.op === "drawImage"; });
    const firstEncodeIndex = ops.findIndex(function (entry) { return entry.op === "toDataURL"; });
    if (firstDrawIndex < 0 || firstEncodeIndex < 0) {
        violations.push("draw or encode never happened: " + JSON.stringify(ops));
    } else {
        if (firstEncodeIndex < firstDrawIndex) {
            violations.push("frame was encoded before it was drawn");
        }
        const before = ops.slice(0, firstDrawIndex);
        const sizedWidth = before.some(function (entry) {
            return entry.op === "width" && entry.value === fitted.width;
        });
        const sizedHeight = before.some(function (entry) {
            return entry.op === "height" && entry.value === fitted.height;
        });
        if (!sizedWidth || !sizedHeight) {
            violations.push("canvas was not sized to the fitted dimensions before drawing: " + JSON.stringify(ops));
        }
        const draw = ops[firstDrawIndex];
        if (draw.canvasWidth !== fitted.width || draw.canvasHeight !== fitted.height ||
            draw.drawWidth !== fitted.width || draw.drawHeight !== fitted.height) {
            violations.push("draw used unbounded dimensions: " + JSON.stringify(draw));
        }
        const encode = ops[firstEncodeIndex];
        if (encode.canvasWidth !== fitted.width || encode.canvasHeight !== fitted.height) {
            violations.push("encode used unbounded canvas dimensions: " + JSON.stringify(encode));
        }
    }

    if (violations.length) {
        throw new Error("PROPERTY_11_COUNTEREXAMPLE " + JSON.stringify({
            sample, fitted, expected, violations, ops, fsOps: run.fsOps,
        }, null, 2));
    }
    return true;
}

describe("media-engine-lag bounded thumbnails", function () {
    // Feature: media-engine-lag, Property 11: Every generated thumbnail is bounded before encoding
    // **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
    test("Property 11: every generated thumbnail is bounded before encoding", function () {
        fc.assert(
            fc.property(thumbnailSourceArbitrary, function (sample) {
                return checkBoundedThumbnail(sample);
            }),
            { numRuns: 200 }
        );
    });
});
// ===========================================================================
// Property 12 harness: fake timers, controllable media resources, object URLs.
// Each run loads a fresh Fast Media instance so disposal is observable.
// ===========================================================================

function p12CreateEventTarget(run, label) {
    const listeners = {};
    const api = {
        listeners: listeners,
        addEventListener: function (name, listener) {
            (listeners[name] = listeners[name] || []).push(listener);
            run.push({ t: "addListener", label: label, name: name });
        },
        removeEventListener: function (name, listener) {
            const bucket = listeners[name] || [];
            for (let i = bucket.length - 1; i >= 0; i--) {
                if (bucket[i] === listener) {
                    bucket.splice(i, 1);
                    run.push({ t: "removeListener", label: label, name: name });
                }
            }
        },
        count: function () {
            let total = 0;
            Object.keys(listeners).forEach(function (name) { total += listeners[name].length; });
            return total;
        },
        dispatch: function (name) {
            const bucket = (listeners[name] || []).slice();
            run.push({ t: "dispatch", label: label, name: name });
            for (let i = 0; i < bucket.length; i++) bucket[i]({ type: name });
            return bucket.length;
        },
    };
    return api;
}

function p12CreateCanvas(run, contextAvailable) {
    let currentWidth = 0;
    let currentHeight = 0;
    const context = {
        fillStyle: "", font: "", textAlign: "",
        drawImage: function () { run.push({ t: "drawImage" }); },
        fillRect: function () { run.push({ t: "fillRect" }); },
        fillText: function () { run.push({ t: "fillText" }); },
        beginPath: function () { }, moveTo: function () { }, lineTo: function () { },
        closePath: function () { }, fill: function () { },
    };
    const canvas = {
        __role: "canvas",
        getContext: function () {
            run.push({ t: "getContext", available: contextAvailable });
            return contextAvailable ? context : null;
        },
        toDataURL: function () { run.push({ t: "toDataURL" }); return ENCODED_PNG; },
    };
    Object.defineProperty(canvas, "width", {
        get: function () { return currentWidth; },
        set: function (value) { currentWidth = value; run.push({ t: "canvasWidth", value: value }); },
    });
    Object.defineProperty(canvas, "height", {
        get: function () { return currentHeight; },
        set: function (value) { currentHeight = value; run.push({ t: "canvasHeight", value: value }); },
    });
    return canvas;
}

function p12CreateVideo(run, sample) {
    const target = p12CreateEventTarget(run, "video");
    const video = {
        __role: "video",
        __target: target,
        muted: false,
        crossOrigin: "",
        duration: 30,
        currentTime: 0,
        src: "",
        parentNode: null,
        videoWidth: sample.width,
        videoHeight: sample.height,
        addEventListener: target.addEventListener,
        removeEventListener: target.removeEventListener,
        pause: function () { run.push({ t: "videoPause" }); },
        load: function () { run.push({ t: "videoLoad" }); },
        removeAttribute: function (name) { video.src = ""; run.push({ t: "videoRemoveAttribute", name: name }); },
    };
    return video;
}

function p12CreateImage(run, sample) {
    const target = p12CreateEventTarget(run, "image");
    const image = {
        __role: "image",
        __target: target,
        naturalWidth: sample.width,
        naturalHeight: sample.height,
        width: sample.width,
        height: sample.height,
        onload: null,
        onerror: null,
        addEventListener: target.addEventListener,
        removeEventListener: target.removeEventListener,
    };
    Object.defineProperty(image, "src", {
        get: function () { return image._src || ""; },
        set: function (value) { image._src = value; run.push({ t: "imageSrc", empty: !value }); },
    });
    return image;
}

function p12CreateRun(scenario) {
    const run = {
        scenario: scenario,
        phase: "decode",
        log: [],
        decodeResources: null,
        decodeElement: null,
        createdUrls: [],
        revoked: {},
        fallbackCanvasCount: 0,
        fallbackStartSnapshot: null,
        settlements: [],
        settleSnapshots: [],
        settleCalls: [],
        writes: [],
        timers: new Map(),
        nextTimerId: 0,
        internals: null,
    };
    run.push = function (entry) {
        entry.phase = run.phase;
        entry.index = run.log.length;
        run.log.push(entry);
        return entry;
    };
    run.pendingTimerCount = function () { return run.timers.size; };
    run.isTracked = function () {
        if (!run.internals || !run.decodeResources) return false;
        return run.internals.getUnfinishedThumbnails().indexOf(run.decodeResources) !== -1;
    };
    run.fireTimers = function () {
        const entries = [];
        run.timers.forEach(function (value, id) { entries.push({ id: id, timer: value }); });
        for (let i = 0; i < entries.length; i++) {
            run.timers.delete(entries[i].id);
            run.push({ t: "timerFired", id: entries[i].id, delay: entries[i].timer.delay });
            entries[i].timer.handler();
        }
        return entries.length;
    };
    return run;
}

/**
 * Promise implementation that snapshots resource state at the exact moment a job
 * calls resolve/reject, so "cleanup before settlement" is checked synchronously.
 */
function p12ObservingPromise(run) {
    return class ObservingPromise extends Promise {
        constructor(executor) {
            super(function (resolve, reject) {
                executor(function (value) {
                    run.settleCalls.push({ value: value, rejected: false, snapshot: p12Snapshot(run) });
                    resolve(value);
                }, function (error) {
                    run.settleCalls.push({ value: error, rejected: true, snapshot: p12Snapshot(run) });
                    reject(error);
                });
            });
        }
    };
}

function p12CreateHarness(scenario) {
    let source = fs.readFileSync(SOURCE_FILE, "utf8");
    const expose = "\nwindow.__property12Internals = {" +
        " getUnfinishedThumbnails: function () { return unfinishedThumbnailResources; }," +
        " cleanupThumbnailResources: cleanupThumbnailResources," +
        " decodeTimeoutMs: DECODE_TIMEOUT_MS," +
        " maxWidth: THUMBNAIL_MAX_WIDTH, maxHeight: THUMBNAIL_MAX_HEIGHT };\n";
    source = source.replace(/\}\)\(window, document\);\s*$/, expose + "})(window, document);");
    if (source.indexOf("__property12Internals") === -1) {
        throw new Error("Fast Media thumbnail internals could not be exposed to the harness");
    }

    const run = p12CreateRun(scenario);
    const fakeFs = {
        promises: {
            mkdir: function () { return Promise.resolve(); },
            writeFile: function (target, data, encoding) {
                run.writes.push({ target: target, data: data, encoding: encoding });
                run.push({ t: "writeFile", target: target });
                return Promise.resolve();
            },
            copyFile: function () { return Promise.resolve(); },
            stat: function () { return Promise.resolve({ size: 1, mtimeMs: 1 }); },
            unlink: function () { return Promise.resolve(); },
        },
        createReadStream: function () { throw new Error("thumbnail work must not stream files"); },
        createWriteStream: function () { throw new Error("thumbnail work must not stream files"); },
        existsSync: function () { throw new Error("thumbnail work must not use synchronous fs"); },
        statSync: function () { throw new Error("thumbnail work must not use synchronous fs"); },
    };

    function trackDecodeResources() {
        const tracked = run.internals ? run.internals.getUnfinishedThumbnails() : [];
        run.decodeResources = tracked.length ? tracked[tracked.length - 1] : null;
        if (!run.decodeResources) return;
        // Simulate job-owned blob and object URLs registered on the real resource scope.
        run.decodeResources.blob = { __ownedBlob: true };
        for (let i = 0; i < scenario.objectUrlCount; i++) {
            run.decodeResources.objectUrls.push(context.window.URL.createObjectURL({ __ownedBlob: true }));
        }
    }

    const context = {
        window: {
            rootPath: "C:/isolated-library",
            addEventListener: function () { },
            URL: {
                createObjectURL: function () {
                    const url = "blob:p12-" + (run.createdUrls.length + 1);
                    run.createdUrls.push(url);
                    run.push({ t: "createObjectURL", url: url });
                    return url;
                },
                revokeObjectURL: function (url) {
                    run.revoked[url] = (run.revoked[url] || 0) + 1;
                    run.push({ t: "revokeObjectURL", url: url });
                },
            },
        },
        document: {
            createElement: function (tag) {
                const name = String(tag).toLowerCase();
                if (name === "canvas") {
                    const fallbackCanvas = run.phase === "fallback";
                    if (fallbackCanvas) {
                        run.fallbackCanvasCount++;
                        run.push({ t: "fallbackCanvasCreated" });
                        if (!run.fallbackStartSnapshot) run.fallbackStartSnapshot = p12Snapshot(run);
                    }
                    return p12CreateCanvas(run, fallbackCanvas ? scenario.fallbackAvailable : true);
                }
                if (name === "video") {
                    run.decodeElement = p12CreateVideo(run, scenario);
                    trackDecodeResources();
                    return run.decodeElement;
                }
                throw new Error("Unexpected element requested: " + tag);
            },
            getElementById: function () { return null; },
            querySelector: function () { return null; },
            querySelectorAll: function () { return []; },
        },
        Image: function () {
            run.decodeElement = p12CreateImage(run, scenario);
            trackDecodeResources();
            return run.decodeElement;
        },
        performance: { now: function () { return 0; } },
        console: { log: function () { }, warn: function () { }, error: function () { } },
        require: function (name) {
            if (name === "fs") return fakeFs;
            if (name === "path") return path;
            throw new Error("Unexpected require: " + name);
        },
        setTimeout: function (handler, delay) {
            run.nextTimerId += 1;
            run.timers.set(run.nextTimerId, { handler: handler, delay: delay });
            run.push({ t: "setTimeout", id: run.nextTimerId, delay: delay });
            return run.nextTimerId;
        },
        clearTimeout: function (id) {
            if (run.timers.has(id)) {
                run.timers.delete(id);
                run.push({ t: "clearTimeout", id: id });
            }
        },
        setInterval: function () { return 0; },
        clearInterval: function () { },
        Promise: p12ObservingPromise(run),
        Date, Math, JSON, Object, Array, String, Number, Error, Map, Set, RegExp, Boolean,
        encodeURI, encodeURIComponent, decodeURIComponent,
        btoa: function () { return ""; },
        unescape: function (value) { return value; },
    };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "fastMediaEngine.js" });
    run.internals = context.window.__property12Internals;

    return {
        run: run,
        window: context.window,
        coordinator: new context.window.MediaWorkCoordinator({}),
    };
}

/** Scheduler-style control fake that records the cleanup/cancel hooks the job registers. */
function p12CreateControl(run) {
    const cancels = [];
    let cancelled = false;
    return {
        cleanups: [],
        cancels: cancels,
        isCancelled: function () { return cancelled; },
        onCancel: function (handler) { cancels.push(handler); return true; },
        registerCleanup: function (handler) { this.cleanups.push(handler); },
        registerResource: function (resource) { return resource; },
        registerStream: function (stream) { return stream; },
        registerVideo: function (video) { return video; },
        registerObjectUrl: function (url) { return url; },
        registerTimer: function (timer) { return timer; },
        registerChildProcess: function (child) { return child; },
        releaseProcess: function () { return true; },
        cancel: function () {
            cancelled = true;
            run.push({ t: "controlCancel" });
            const handlers = cancels.slice();
            for (let i = 0; i < handlers.length; i++) handlers[i]();
        },
        runCleanups: function () {
            const handlers = this.cleanups.slice();
            for (let i = 0; i < handlers.length; i++) handlers[i]();
        },
    };
}

function p12Snapshot(run) {
    const resources = run.decodeResources;
    const element = run.decodeElement;
    return {
        logIndex: run.log.length,
        cleaned: !!(resources && resources.cleaned),
        listeners: resources ? resources.listeners.length : -1,
        timeout: resources ? resources.timeout : "missing-resources",
        videoRef: !!resources && resources.video === null,
        canvasRef: !!resources && resources.canvas === null,
        contextRef: !!resources && resources.context === null,
        imageRef: !!resources && resources.image === null,
        blobRef: !!resources && resources.blob === null,
        encodedRef: !!resources && resources.encodedImage === null,
        objectUrlsRef: resources ? resources.objectUrls.length : -1,
        elementListeners: element && element.__target ? element.__target.count() : -1,
        pendingTimers: run.pendingTimerCount(),
        tracked: run.isTracked(),
        revokes: run.createdUrls.map(function (url) { return run.revoked[url] || 0; }),
    };
}

function p12CheckReleased(label, snapshot, violations) {
    if (!snapshot) {
        violations.push(label + ": no snapshot was captured");
        return;
    }
    if (!snapshot.cleaned) violations.push(label + ": cleanup had not run");
    if (snapshot.listeners !== 0) violations.push(label + ": job listeners remained (" + snapshot.listeners + ")");
    if (snapshot.timeout !== null) violations.push(label + ": decode timer was still held (" + snapshot.timeout + ")");
    if (!snapshot.videoRef || !snapshot.canvasRef || !snapshot.contextRef ||
        !snapshot.imageRef || !snapshot.blobRef || !snapshot.encodedRef) {
        violations.push(label + ": job-owned media references were still held " + JSON.stringify(snapshot));
    }
    if (snapshot.objectUrlsRef !== 0) violations.push(label + ": object URL list was not emptied");
    if (snapshot.elementListeners !== 0) {
        violations.push(label + ": decode element listeners remained (" + snapshot.elementListeners + ")");
    }
    if (snapshot.pendingTimers !== 0) violations.push(label + ": timers remained pending (" + snapshot.pendingTimers + ")");
    if (snapshot.tracked) violations.push(label + ": resources were still tracked as unfinished");
    for (let i = 0; i < snapshot.revokes.length; i++) {
        if (snapshot.revokes[i] !== 1) {
            violations.push(label + ": object URL " + i + " was revoked " + snapshot.revokes[i] + " times");
        }
    }
}

function p12Flush() {
    let chain = Promise.resolve();
    for (let i = 0; i < 12; i++) chain = chain.then(function () { });
    return chain;
}

const p12ScenarioArbitrary = fc.record({
    kind: fc.constantFrom("image", "video"),
    outcome: fc.constantFrom("success", "decode-error", "timeout", "cancel", "dispose"),
    fallbackAvailable: fc.boolean(),
    partialProgress: fc.boolean(),
    objectUrlCount: fc.integer({ min: 0, max: 3 }),
    width: fc.oneof(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 41, max: 4096 })),
    height: fc.oneof(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 41, max: 4096 })),
});

async function p12CheckCleanupAndFallback(scenario) {
    const violations = [];
    const harness = p12CreateHarness(scenario);
    const run = harness.run;
    const control = p12CreateControl(run);
    const isVideo = scenario.kind === "video";
    const item = {
        id: "media-1",
        isVideo: isVideo,
        fileName: isVideo ? "clip.mp4" : "frame.png",
        safeName: "clip",
        destinationMedia: isVideo ? "C:/library/clip.mp4" : "C:/library/frame.png",
        destinationThumbnail: "C:/library/thumbnail.png",
        destinationFolder: "C:/library",
    };

    const promise = harness.coordinator._defaultThumbnail(item, control);
    promise.then(function (result) {
        run.push({ t: "settle", kind: "resolved", ok: !!(result && result.ok) });
        run.settlements.push({ type: "resolved", result: result });
        run.settleSnapshots.push(p12Snapshot(run));
    }, function (error) {
        run.push({ t: "settle", kind: "rejected" });
        run.settlements.push({ type: "rejected", error: error });
        run.settleSnapshots.push(p12Snapshot(run));
    });
    await p12Flush();

    if (!run.decodeResources) violations.push("the decode job never created an owned resource scope");
    if (run.settlements.length !== 0) violations.push("the job settled before any decode event was delivered");
    const armed = run.log.filter(function (entry) { return entry.t === "setTimeout"; });
    if (armed.length !== 1 || armed[0].delay !== run.internals.decodeTimeoutMs) {
        violations.push("decode did not arm exactly one 10s timeout: " + JSON.stringify(armed));
    }

    if (scenario.partialProgress && isVideo) run.decodeElement.__target.dispatch("loadeddata");

    if (scenario.outcome === "success") {
        if (isVideo) {
            if (!scenario.partialProgress) run.decodeElement.__target.dispatch("loadeddata");
            run.decodeElement.__target.dispatch("seeked");
        } else {
            run.decodeElement.__target.dispatch("load");
        }
    } else if (scenario.outcome === "decode-error") {
        run.decodeElement.__target.dispatch("error");
        run.phase = "fallback";
    } else if (scenario.outcome === "timeout") {
        const fired = run.fireTimers();
        if (fired !== 1) violations.push("expected exactly one pending decode timer, fired " + fired);
        run.phase = "fallback";
    } else if (scenario.outcome === "cancel") {
        control.cancel();
    } else {
        harness.window.FastMedia.dispose();
    }
    await p12Flush();

    // Idempotency: every cleanup entry point may run again with no further effect.
    const beforeRepeat = p12Snapshot(run);
    control.cancel();
    control.runCleanups();
    run.internals.cleanupThumbnailResources(run.decodeResources);
    harness.window.FastMedia.dispose();
    await p12Flush();
    const afterRepeat = p12Snapshot(run);
    const repeatedWork = run.log.slice(beforeRepeat.logIndex).filter(function (entry) {
        return entry.t === "revokeObjectURL" || entry.t === "removeListener" ||
            entry.t === "clearTimeout" || entry.t === "canvasWidth" || entry.t === "canvasHeight" ||
            entry.t === "videoRemoveAttribute" || entry.t === "fallbackCanvasCreated" ||
            entry.t === "writeFile" || entry.t === "settle";
    });
    if (repeatedWork.length !== 0) {
        violations.push("repeated cleanup produced additional effects: " + JSON.stringify(repeatedWork));
    }

    p12CheckReleased("after cleanup", afterRepeat, violations);
    for (let i = 0; i < run.settlements.length; i++) {
        const settled = run.settlements[i];
        const settledValue = settled.type === "resolved" ? settled.result : settled.error;
        const call = run.settleCalls.filter(function (entry) { return entry.value === settledValue; })[0];
        if (!call) {
            violations.push("no resolve/reject callsite was observed for the settled value");
        } else {
            p12CheckReleased("at the settlement callsite", call.snapshot, violations);
        }
    }
    if (run.fallbackCanvasCount > 0) {
        p12CheckReleased("at fallback start", run.fallbackStartSnapshot, violations);
    }
    if (run.fallbackCanvasCount > 1) {
        violations.push("codec fallback ran " + run.fallbackCanvasCount + " times");
    }

    const settlements = run.settlements;
    const failedDecode = scenario.outcome === "decode-error" || scenario.outcome === "timeout";
    if (scenario.outcome === "success") {
        if (settlements.length !== 1 || settlements[0].type !== "resolved" || !settlements[0].result.ok) {
            violations.push("successful decode did not settle once as available: " + JSON.stringify(settlements));
        }
        if (run.fallbackCanvasCount !== 0) violations.push("a successful decode invoked the codec fallback");
    } else if (failedDecode) {
        if (settlements.length !== 1) {
            violations.push("failed decode settled " + settlements.length + " times");
        } else if (isVideo && scenario.fallbackAvailable) {
            if (settlements[0].type !== "resolved" || !settlements[0].result.ok || !settlements[0].result.fallback) {
                violations.push("available fallback did not produce one fallback result: " + JSON.stringify(settlements));
            }
            if (run.fallbackCanvasCount !== 1) {
                violations.push("available fallback ran " + run.fallbackCanvasCount + " times");
            }
        } else {
            const settled = settlements[0];
            const failedResult = settled.type === "rejected" ||
                (settled.result && settled.result.ok === false);
            if (!failedResult) {
                violations.push("unavailable fallback did not settle as failed: " + JSON.stringify(settlements));
            }
            if (!isVideo && run.fallbackCanvasCount !== 0) {
                violations.push("image decode failure invoked a codec fallback");
            }
        }
    } else if (settlements.length !== 0) {
        violations.push(scenario.outcome + " settled the job " + settlements.length + " times");
    } else if (run.fallbackCanvasCount !== 0) {
        violations.push(scenario.outcome + " started a codec fallback");
    }

    if (violations.length) {
        throw new Error("PROPERTY_12_COUNTEREXAMPLE " + JSON.stringify({
            scenario: scenario,
            violations: violations,
            settlements: settlements.map(function (entry) {
                return { type: entry.type, result: entry.result || String(entry.error) };
            }),
            fallbackCanvasCount: run.fallbackCanvasCount,
            log: run.log,
        }, null, 2));
    }
    return true;
}

describe("media-engine-lag thumbnail cleanup and fallback", function () {
    // Feature: media-engine-lag, Property 12: Thumbnail cleanup and fallback are deterministic
    // **Validates: Requirements 4.5, 4.6, 4.7, 4.8**
    test("Property 12: thumbnail cleanup and fallback are deterministic", async function () {
        await fc.assert(
            fc.asyncProperty(p12ScenarioArbitrary, async function (scenario) {
                return p12CheckCleanupAndFallback(scenario);
            }),
            { numRuns: 120 }
        );
    }, 300000);
});
