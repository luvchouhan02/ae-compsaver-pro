"use strict";

/**
 * Feature: media-engine-lag (Task 6.7)
 * Example (non-property) tests for the real Fast Media stage workers:
 * thumbnail fit boundaries, decode success/error/timeout, unavailable codec fallback,
 * FFmpeg success/error/timeout/missing executable, and disposal during every stage.
 *
 * Requirements: 3.9, 4.1-4.8, 5.1-5.3, 7.1, 7.3
 */

const nodeFs = require("fs");
const path = require("path");
const vm = require("vm");
const schedulerModule = require(path.resolve(__dirname, "../js/core/scheduler.js"));

const ROOT = path.resolve(__dirname, "..");
const ENGINE_SOURCE = nodeFs.readFileSync(path.join(ROOT, "js/core/fastMediaEngine.js"), "utf8");
const ENCODED_PNG = "data:image/png;base64,QUJDREVG";
const DECODE_TIMEOUT_MS = 10000;
const FFMPEG_TIMEOUT_MS = 60000;

function exposeInternals(source) {
    const expose = "\nwindow.__stageWorkers = {" +
        " generateImageThumbnail: generateImageThumbnail," +
        " extractVideoFrame: extractVideoFrame," +
        " generateFallbackThumbnail: generateFallbackThumbnail," +
        " copyFileStream: copyFileStream," +
        " runFfmpegFallback: runFfmpegFallback," +
        " unfinishedThumbnails: function () { return unfinishedThumbnailResources; }," +
        " ownedChildren: function () { return mediaOwnedChildren; }," +
        " decodeTimeoutMs: DECODE_TIMEOUT_MS," +
        " ffmpegTimeoutMs: FFMPEG_TIMEOUT_MS };\n";
    const patched = source.replace(/\}\)\(window, document\);\s*$/, expose + "})(window, document);");
    if (patched.indexOf("__stageWorkers") === -1) {
        throw new Error("Fast Media stage workers could not be exposed to the harness");
    }
    return patched;
}

const ENGINE_SCRIPT = new vm.Script(exposeInternals(ENGINE_SOURCE), { filename: "fastMediaEngine.js" });

function flush(times) {
    let chain = Promise.resolve();
    const rounds = times || 6;
    for (let i = 0; i < rounds; i++) {
        chain = chain.then(function () {
            return new Promise(function (resolve) { setImmediate(resolve); });
        });
    }
    return chain;
}

async function waitFor(predicate, label) {
    for (let i = 0; i < 200; i++) {
        if (predicate()) return true;
        await flush(1);
    }
    throw new Error("Timed out waiting for: " + label);
}

function createEventTarget(state, label) {
    const listeners = {};
    return {
        listeners: listeners,
        add: function (name, listener) { (listeners[name] = listeners[name] || []).push(listener); },
        remove: function (name, listener) {
            const bucket = listeners[name] || [];
            for (let i = bucket.length - 1; i >= 0; i--) {
                if (bucket[i] === listener) bucket.splice(i, 1);
            }
        },
        count: function () {
            let total = 0;
            Object.keys(listeners).forEach(function (name) { total += listeners[name].length; });
            return total;
        },
        dispatch: function (name) {
            const bucket = (listeners[name] || []).slice();
            state.events.push({ label: label, name: name, delivered: bucket.length });
            for (let i = 0; i < bucket.length; i++) bucket[i]({ type: name });
            return bucket.length;
        },
    };
}

function createCanvas(state) {
    let width = 0;
    let height = 0;
    const ops = [];
    const context = {
        fillStyle: "", font: "", textAlign: "",
        drawImage: function (source, x, y, drawWidth, drawHeight) {
            ops.push({ op: "drawImage", drawWidth: drawWidth, drawHeight: drawHeight });
        },
        fillRect: function () { ops.push({ op: "fillRect" }); },
        fillText: function () { ops.push({ op: "fillText" }); },
        beginPath: function () { }, moveTo: function () { }, lineTo: function () { },
        closePath: function () { }, fill: function () { },
    };
    const canvas = {
        role: "canvas",
        ops: ops,
        getContext: function () {
            ops.push({ op: "getContext", available: state.canvasContextAvailable });
            return state.canvasContextAvailable ? context : null;
        },
        toDataURL: function (type) {
            ops.push({ op: "toDataURL", type: type, width: width, height: height });
            return ENCODED_PNG;
        },
    };
    Object.defineProperty(canvas, "width", {
        get: function () { return width; },
        set: function (value) { width = value; ops.push({ op: "width", value: value }); },
    });
    Object.defineProperty(canvas, "height", {
        get: function () { return height; },
        set: function (value) { height = value; ops.push({ op: "height", value: value }); },
    });
    state.canvases.push(canvas);
    return canvas;
}

function createVideoElement(state) {
    const target = createEventTarget(state, "video");
    const video = {
        role: "video",
        target: target,
        muted: false,
        crossOrigin: "",
        duration: 30,
        currentTime: 0,
        parentNode: null,
        videoWidth: state.mediaWidth,
        videoHeight: state.mediaHeight,
        pauseCalls: 0,
        loadCalls: 0,
        removedAttributes: [],
        addEventListener: target.add,
        removeEventListener: target.remove,
        pause: function () { video.pauseCalls++; },
        load: function () { video.loadCalls++; },
        removeAttribute: function (name) { video.removedAttributes.push(name); video._src = ""; },
    };
    Object.defineProperty(video, "src", {
        get: function () { return video._src || ""; },
        set: function (value) {
            video._src = value;
            if (!value || state.videoDecode === "manual") return;
            if (state.videoDecode === "error") {
                Promise.resolve().then(function () { target.dispatch("error"); });
                return;
            }
            Promise.resolve()
                .then(function () { target.dispatch("loadeddata"); })
                .then(function () { target.dispatch("seeked"); });
        },
    });
    state.videos.push(video);
    return video;
}

function createImageElement(state) {
    const target = createEventTarget(state, "image");
    const image = {
        role: "image",
        target: target,
        naturalWidth: state.mediaWidth,
        naturalHeight: state.mediaHeight,
        width: state.mediaWidth,
        height: state.mediaHeight,
        onload: null,
        onerror: null,
        addEventListener: target.add,
        removeEventListener: target.remove,
    };
    Object.defineProperty(image, "src", {
        get: function () { return image._src || ""; },
        set: function (value) {
            image._src = value;
            if (!value || state.imageDecode === "manual") return;
            const eventName = state.imageDecode === "error" ? "error" : "load";
            Promise.resolve().then(function () { target.dispatch(eventName); });
        },
    });
    state.images.push(image);
    return image;
}

function createFakeChild(state, executable, args, callback) {
    const handlers = {};
    const child = {
        executable: executable,
        args: args,
        killed: false,
        callbackCalls: 0,
        on: function (name, listener) { (handlers[name] = handlers[name] || []).push(listener); return child; },
        once: function (name, listener) { return child.on(name, listener); },
        removeListener: function (name, listener) {
            const bucket = handlers[name] || [];
            for (let i = bucket.length - 1; i >= 0; i--) {
                if (bucket[i] === listener) bucket.splice(i, 1);
            }
            return child;
        },
        emit: function (name, value) {
            const bucket = (handlers[name] || []).slice();
            for (let i = 0; i < bucket.length; i++) bucket[i](value);
        },
        settle: function (error) {
            if (child.callbackCalls) return;
            child.callbackCalls++;
            child.emit(error ? "error" : "close", error || 0);
            callback(error || null, "", "");
        },
        kill: function () {
            if (child.killed) return;
            child.killed = true;
            state.kills.push(child.args.join(" "));
            Promise.resolve().then(function () { child.settle(new Error("ffmpeg killed")); });
        },
    };
    state.children.push(child);
    return child;
}

function createHarness(options) {
    options = options || {};
    const state = {
        files: {},
        mkdirs: [],
        writes: [],
        unlinks: [],
        streams: [],
        copies: [],
        timers: new Map(),
        nextTimer: 0,
        events: [],
        canvases: [],
        videos: [],
        images: [],
        children: [],
        kills: [],
        createdUrls: [],
        revokedUrls: [],
        canvasContextAvailable: options.canvasContextAvailable !== false,
        imageDecode: options.imageDecode || "success",
        videoDecode: options.videoDecode || "success",
        mediaWidth: options.mediaWidth === undefined ? 1920 : options.mediaWidth,
        mediaHeight: options.mediaHeight === undefined ? 1080 : options.mediaHeight,
        ffmpegExecutable: options.ffmpegExecutable === undefined ? "C:/tools/ffmpeg.exe" : options.ffmpegExecutable,
        ffmpegPlan: options.ffmpegPlan || [],
        autoCopy: options.autoCopy !== false,
        chunkSize: options.chunkSize || 4,
    };

    state.write = function (target, bytes) { state.files[target] = bytes.slice(); };
    state.bytesOf = function (target) { return state.files[target] ? state.files[target].slice() : null; };
    state.pendingTimerCount = function () { return state.timers.size; };
    state.fireDelay = function (delay) {
        let fired = 0;
        const entries = [];
        state.timers.forEach(function (timer, id) { if (timer.delay === delay) entries.push({ id: id, timer: timer }); });
        for (let i = 0; i < entries.length; i++) {
            state.timers.delete(entries[i].id);
            entries[i].timer.handler();
            fired++;
        }
        return fired;
    };

    function nextFfmpegPlan(index) {
        if (index < state.ffmpegPlan.length) return state.ffmpegPlan[index];
        return "success";
    }

    const fakeFs = {
        promises: {
            mkdir: function (target) { state.mkdirs.push(target); return Promise.resolve(); },
            writeFile: function (target, data, encoding) {
                state.writes.push({ target: target, data: data, encoding: encoding });
                state.files[target] = [1];
                return Promise.resolve();
            },
            copyFile: function (from, to) {
                state.copies.push({ from: from, to: to });
                state.files[to] = (state.files[from] || []).slice();
                return Promise.resolve();
            },
            stat: function (target) {
                if (!state.files[target]) return Promise.reject(new Error("ENOENT: " + target));
                return Promise.resolve({ size: state.files[target].length, mtimeMs: 1 });
            },
            unlink: function (target) {
                state.unlinks.push(target);
                delete state.files[target];
                return Promise.resolve();
            },
        },
        createReadStream: function (source) {
            const handlers = {};
            const stream = {
                mode: "read",
                path: source,
                destroyed: false,
                on: function (name, listener) { (handlers[name] = handlers[name] || []).push(listener); return stream; },
                emit: function (name, value) {
                    const bucket = (handlers[name] || []).slice();
                    for (let i = 0; i < bucket.length; i++) bucket[i](value);
                },
                destroy: function () {
                    if (stream.destroyed) return;
                    stream.destroyed = true;
                },
                pipe: function (writer) {
                    const bytes = state.files[source] || [];
                    const chunks = [];
                    for (let i = 0; i < bytes.length; i += state.chunkSize) {
                        chunks.push(bytes.slice(i, i + state.chunkSize));
                    }
                    let index = 0;
                    stream.step = function () {
                        if (stream.destroyed || writer.destroyed || writer.ended) return false;
                        if (state.readError && index === 0) {
                            stream.emit("error", new Error("injected read failure"));
                            return false;
                        }
                        if (state.writeError && index === 0) {
                            writer.emit("error", new Error("injected write failure"));
                            return false;
                        }
                        if (index >= chunks.length) {
                            writer.end();
                            return false;
                        }
                        writer.write(chunks[index]);
                        index++;
                        return true;
                    };
                    if (state.autoCopy) {
                        (function pump() {
                            Promise.resolve().then(function () {
                                if (stream.step()) pump();
                            });
                        })();
                    }
                    return writer;
                },
            };
            state.streams.push(stream);
            return stream;
        },
        createWriteStream: function (target) {
            const handlers = {};
            state.files[target] = [];
            const stream = {
                mode: "write",
                path: target,
                destroyed: false,
                ended: false,
                on: function (name, listener) { (handlers[name] = handlers[name] || []).push(listener); return stream; },
                emit: function (name, value) {
                    const bucket = (handlers[name] || []).slice();
                    for (let i = 0; i < bucket.length; i++) bucket[i](value);
                },
                write: function (chunk) {
                    if (stream.destroyed || stream.ended) return false;
                    const bytes = state.files[target] || (state.files[target] = []);
                    for (let i = 0; i < chunk.length; i++) bytes.push(chunk[i]);
                    return true;
                },
                end: function () {
                    if (stream.ended || stream.destroyed) return;
                    stream.ended = true;
                    stream.emit("close");
                },
                destroy: function () {
                    if (stream.destroyed) return;
                    stream.destroyed = true;
                },
            };
            state.streams.push(stream);
            return stream;
        },
        existsSync: function () { throw new Error("stage workers must not use synchronous fs"); },
        statSync: function () { throw new Error("stage workers must not use synchronous fs"); },
        readFileSync: function () { throw new Error("stage workers must not use synchronous fs"); },
        writeFileSync: function () { throw new Error("stage workers must not use synchronous fs"); },
        copyFileSync: function () { throw new Error("stage workers must not use synchronous fs"); },
    };

    const fakeChildProcess = {
        execFile: function (executable, args, opts, callback) {
            const index = state.children.length;
            const child = createFakeChild(state, executable, args, callback);
            const plan = nextFfmpegPlan(index);
            if (plan === "success") Promise.resolve().then(function () { child.settle(null); });
            else if (plan === "error") Promise.resolve().then(function () { child.settle(new Error("ffmpeg exited 1")); });
            return child;
        },
    };

    const scheduler = schedulerModule.createScheduler();
    const context = {
        window: {
            rootPath: "C:/library",
            Scheduler: scheduler,
            addEventListener: function () { },
            removeEventListener: function () { },
            URL: {
                createObjectURL: function () {
                    const url = "blob:stage-" + (state.createdUrls.length + 1);
                    state.createdUrls.push(url);
                    return url;
                },
                revokeObjectURL: function (url) { state.revokedUrls.push(url); },
            },
        },
        document: {
            getElementById: function () { return null; },
            querySelector: function () { return null; },
            querySelectorAll: function () { return []; },
            createElement: function (tag) {
                const name = String(tag).toLowerCase();
                if (name === "canvas") return createCanvas(state);
                if (name === "video") return createVideoElement(state);
                throw new Error("Unexpected element requested: " + tag);
            },
        },
        Image: function () { return createImageElement(state); },
        performance: { now: function () { return 0; } },
        console: { log: function () { }, warn: function () { }, error: function () { } },
        showToast: function () { },
        getLibraryIndex: function () { return null; },
        require: function (name) {
            if (name === "fs") return fakeFs;
            if (name === "path") return path;
            if (name === "child_process") return fakeChildProcess;
            throw new Error("Unexpected require: " + name);
        },
        setTimeout: function (handler, delay) {
            state.nextTimer++;
            state.timers.set(state.nextTimer, { handler: handler, delay: delay });
            return state.nextTimer;
        },
        clearTimeout: function (id) { state.timers.delete(id); },
        setInterval: function () { return 0; },
        clearInterval: function () { },
        Promise: Promise,
        btoa: function () { return ""; },
        unescape: function (value) { return value; },
    };
    context.window.window = context.window;
    if (state.ffmpegExecutable) {
        context.window.resolveFfmpeg = function (callback) { callback(state.ffmpegExecutable); };
    }
    vm.createContext(context);
    ENGINE_SCRIPT.runInContext(context);

    return {
        state: state,
        scheduler: scheduler,
        window: context.window,
        workers: context.window.__stageWorkers,
        FastMedia: context.window.FastMedia,
    };
}

function createCoordinator(harness, options) {
    options = options || {};
    const record = {
        repositoryPatches: [],
        cardPatches: [],
        terminals: [],
        idleSnapshots: [],
    };
    record.coordinator = harness.FastMedia.createWorkCoordinator({
        scheduler: harness.scheduler,
        repository: {
            patchById: function (id, fields) {
                record.repositoryPatches.push({ id: id, fields: fields });
                return Promise.resolve({ ok: true });
            },
        },
        cardHelper: {
            patchById: function (id, fields) {
                record.cardPatches.push({ id: id, fields: fields });
                return { ok: true, updated: 1 };
            },
            dispose: function () { record.cardsDisposed = true; },
        },
        workers: options.workers || {},
        progressIntervalMs: options.progressIntervalMs || 500,
        onTerminal: function (item, terminal) { record.terminals.push({ id: item.id, terminal: terminal }); },
        onIdle: function (snapshot) { record.idleSnapshots.push(snapshot); },
    });
    return record;
}

function createItem(harness, options) {
    options = options || {};
    const fileName = options.fileName || "clip.mp4";
    const folder = "C:/library/footage/asset";
    const sourcePath = "C:/originals/" + fileName;
    harness.state.write(sourcePath, options.bytes || [10, 20, 30, 40, 50, 60, 70]);
    return {
        id: options.id || "media-1",
        sourcePath: sourcePath,
        destinationFolder: folder,
        destinationMedia: folder + "/" + fileName,
        destinationThumbnail: folder + "/thumbnail.png",
        fileName: fileName,
        safeName: "asset",
        extension: path.extname(fileName),
        isVideo: options.isVideo !== false,
        token: 1,
    };
}

async function settleScheduler(harness) {
    await flush(4);
    await harness.scheduler.drain("filesystem");
    await harness.scheduler.drain("thumbnail");
    await harness.scheduler.drain("ffmpeg");
    await flush(4);
}

// ===========================================================================
// Thumbnail fit boundaries (Requirements 4.1-4.4)
// ===========================================================================
describe("fast media thumbnail fit boundaries", function () {
    let harness;

    beforeAll(function () { harness = createHarness(); });
    afterAll(function () { harness.scheduler.dispose(); });

    test("keeps a source already at exactly 320x180 untouched", function () {
        expect(harness.FastMedia.fitThumbnailDimensions(320, 180)).toEqual({ width: 320, height: 180, scale: 1 });
    });

    test("scales a source one pixel wider than the bound", function () {
        const fitted = harness.FastMedia.fitThumbnailDimensions(321, 180);
        expect({ width: fitted.width, height: fitted.height }).toEqual({ width: 320, height: 179 });
        expect(fitted.scale).toBeLessThan(1);
    });

    test("scales a source one pixel taller than the bound", function () {
        const fitted = harness.FastMedia.fitThumbnailDimensions(320, 181);
        expect({ width: fitted.width, height: fitted.height }).toEqual({ width: 318, height: 180 });
        expect(fitted.scale).toBeLessThan(1);
    });

    test("never upscales a 1x1 source", function () {
        expect(harness.FastMedia.fitThumbnailDimensions(1, 1)).toEqual({ width: 1, height: 1, scale: 1 });
    });

    test("clamps sub-pixel dimensions to 1 on extreme aspect ratios", function () {
        const wide = harness.FastMedia.fitThumbnailDimensions(3200, 1);
        const tall = harness.FastMedia.fitThumbnailDimensions(1, 1800);
        expect({ width: wide.width, height: wide.height }).toEqual({ width: 320, height: 1 });
        expect({ width: tall.width, height: tall.height }).toEqual({ width: 1, height: 180 });
        expect(harness.FastMedia.fitThumbnailDimensions(20000, 1).height).toBe(1);
    });

    test("fits common HD sources inside the bound", function () {
        expect(harness.FastMedia.fitThumbnailDimensions(1920, 1080)).toEqual({ width: 320, height: 180, scale: 320 / 1920 });
        const small = harness.FastMedia.fitThumbnailDimensions(319, 179);
        expect({ width: small.width, height: small.height, scale: small.scale }).toEqual({ width: 319, height: 179, scale: 1 });
    });

    test("degrades unusable dimensions to a 1x1 zero-scale result", function () {
        expect(harness.FastMedia.fitThumbnailDimensions(0, 180)).toEqual({ width: 1, height: 1, scale: 0 });
        expect(harness.FastMedia.fitThumbnailDimensions(-5, 10)).toEqual({ width: 1, height: 1, scale: 0 });
        expect(harness.FastMedia.fitThumbnailDimensions("nope", 10)).toEqual({ width: 1, height: 1, scale: 0 });
    });
});

// ===========================================================================
// Decode success / error / timeout (Requirements 4.1-4.7)
// ===========================================================================
describe("fast media decode outcomes", function () {
    test("image decode success writes one bounded derivative and releases resources", async function () {
        const harness = createHarness({ mediaWidth: 1920, mediaHeight: 1080 });
        const result = await harness.workers.generateImageThumbnail("C:/originals/frame.png", "C:/library/thumb.png", null);
        expect(result).toEqual({ ok: true, path: "C:/library/thumb.png", width: 320, height: 180 });
        const canvas = harness.state.canvases[0];
        expect(canvas.ops).toEqual(expect.arrayContaining([
            { op: "width", value: 320 },
            { op: "height", value: 180 },
            { op: "drawImage", drawWidth: 320, drawHeight: 180 },
        ]));
        expect(harness.state.writes).toEqual([
            { target: "C:/library/thumb.png", data: "QUJDREVG", encoding: "base64" },
        ]);
        expect(harness.workers.unfinishedThumbnails().length).toBe(0);
        expect(harness.state.pendingTimerCount()).toBe(0);
        expect(harness.state.images[0].target.count()).toBe(0);
        harness.scheduler.dispose();
    });

    test("image decode error rejects once, writes nothing and releases resources", async function () {
        const harness = createHarness({ imageDecode: "error" });
        await expect(harness.workers.generateImageThumbnail("C:/originals/frame.png", "C:/library/thumb.png", null))
            .rejects.toThrow("Image decoding failed");
        expect(harness.state.writes).toEqual([]);
        expect(harness.workers.unfinishedThumbnails().length).toBe(0);
        expect(harness.state.pendingTimerCount()).toBe(0);
        expect(harness.state.images[0].src).toBe("");
        harness.scheduler.dispose();
    });

    test("image decode that never completes fails on the 10-second decode timeout", async function () {
        const harness = createHarness({ imageDecode: "manual" });
        const pending = harness.workers.generateImageThumbnail("C:/originals/frame.png", "C:/library/thumb.png", null);
        const assertion = expect(pending).rejects.toThrow("Image decoding timed out");
        await flush(2);
        expect(harness.state.pendingTimerCount()).toBe(1);
        expect(harness.state.fireDelay(DECODE_TIMEOUT_MS)).toBe(1);
        await assertion;
        expect(harness.state.writes).toEqual([]);
        expect(harness.state.pendingTimerCount()).toBe(0);
        expect(harness.workers.unfinishedThumbnails().length).toBe(0);
        harness.scheduler.dispose();
    });

    test("video decode success draws one bounded frame and releases the decoder", async function () {
        const harness = createHarness({ mediaWidth: 640, mediaHeight: 360 });
        const result = await harness.workers.extractVideoFrame("C:/originals/clip.mp4", 0.5, "C:/library/thumb.png", null);
        expect(result).toEqual({ ok: true, path: "C:/library/thumb.png", width: 320, height: 180 });
        const video = harness.state.videos[0];
        expect(video.currentTime).toBe(0.5);
        expect(video.pauseCalls).toBeGreaterThanOrEqual(1);
        expect(video.removedAttributes).toContain("src");
        expect(video.target.count()).toBe(0);
        expect(harness.state.writes.length).toBe(1);
        expect(harness.workers.unfinishedThumbnails().length).toBe(0);
        expect(harness.state.pendingTimerCount()).toBe(0);
        harness.scheduler.dispose();
    });

    test("video decode error rejects once and releases the decoder", async function () {
        const harness = createHarness({ videoDecode: "error" });
        await expect(harness.workers.extractVideoFrame("C:/originals/clip.mp4", 0.5, "C:/library/thumb.png", null))
            .rejects.toThrow("HTML5 video decoding failed");
        expect(harness.state.writes).toEqual([]);
        expect(harness.state.videos[0].target.count()).toBe(0);
        expect(harness.state.videos[0].removedAttributes).toContain("src");
        expect(harness.workers.unfinishedThumbnails().length).toBe(0);
        expect(harness.state.pendingTimerCount()).toBe(0);
        harness.scheduler.dispose();
    });

    test("video decode that never seeks fails on the 10-second decode timeout", async function () {
        const harness = createHarness({ videoDecode: "manual" });
        const pending = harness.workers.extractVideoFrame("C:/originals/clip.mp4", 0.5, "C:/library/thumb.png", null);
        const assertion = expect(pending).rejects.toThrow("Video decoding timed out");
        await flush(2);
        const timers = [];
        harness.state.timers.forEach(function (timer) { timers.push(timer.delay); });
        expect(timers).toEqual([DECODE_TIMEOUT_MS]);
        expect(harness.state.fireDelay(DECODE_TIMEOUT_MS)).toBe(1);
        await assertion;
        expect(harness.state.pendingTimerCount()).toBe(0);
        expect(harness.workers.unfinishedThumbnails().length).toBe(0);
        harness.scheduler.dispose();
    });
});

// ===========================================================================
// Codec fallback availability and single settlement (Requirements 4.5-4.8, 3.9)
// ===========================================================================
describe("fast media codec fallback", function () {
    test("fallback artwork is bounded to 320x180 and written once", async function () {
        const harness = createHarness();
        const result = await harness.workers.generateFallbackThumbnail("C:/library/thumb.png", "clip.mp4", null);
        expect(result).toEqual({ ok: true, path: "C:/library/thumb.png", width: 320, height: 180, fallback: true });
        expect(harness.state.canvases[0].ops).toEqual(expect.arrayContaining([
            { op: "width", value: 320 },
            { op: "height", value: 180 },
        ]));
        expect(harness.state.writes.length).toBe(1);
        expect(harness.workers.unfinishedThumbnails().length).toBe(0);
        harness.scheduler.dispose();
    });

    test("unavailable fallback rejects once and leaves no unfinished resources", async function () {
        const harness = createHarness({ canvasContextAvailable: false });
        await expect(harness.workers.generateFallbackThumbnail("C:/library/thumb.png", "clip.mp4", null))
            .rejects.toThrow("Canvas context unavailable");
        expect(harness.state.writes).toEqual([]);
        expect(harness.workers.unfinishedThumbnails().length).toBe(0);
        expect(harness.state.pendingTimerCount()).toBe(0);
        harness.scheduler.dispose();
    });

    test("unavailable fallback plus unavailable FFmpeg settles the job exactly once", async function () {
        const harness = createHarness({
            videoDecode: "error",
            canvasContextAvailable: false,
            ffmpegExecutable: "",
        });
        const record = createCoordinator(harness);
        const item = createItem(harness, { id: "fallback-unavailable" });
        const snapshot = await record.coordinator.submitBatch({ id: "batch-fallback", items: [item] });
        await settleScheduler(harness);

        expect(snapshot.idle).toBe(true);
        expect(snapshot.terminalCount).toBe(1);
        expect(record.terminals.length).toBe(1);
        expect(record.repositoryPatches.length).toBe(1);
        expect(record.cardPatches.length).toBe(1);
        expect(record.repositoryPatches[0].fields.thumbStatus).toBe("failed");
        expect(record.repositoryPatches[0].fields.derivativeStatus).toBe("derivative-unavailable");
        expect(item.stages.thumbnail.state).toBe("derivative-unavailable");
        expect(item.stages.ffmpeg.state).toBe("derivative-unavailable");
        expect(harness.workers.unfinishedThumbnails().length).toBe(0);
        expect(harness.state.pendingTimerCount()).toBe(0);
        harness.scheduler.dispose();
    });

    test("a failed copy settles the job as failed exactly once and keeps the source intact", async function () {
        const harness = createHarness();
        harness.state.writeError = true;
        const record = createCoordinator(harness);
        const item = createItem(harness, { id: "copy-failure", bytes: [1, 2, 3, 4, 5] });
        const snapshot = await record.coordinator.submitBatch({ id: "batch-copy-failure", items: [item] });
        await settleScheduler(harness);

        expect(snapshot.terminalCount).toBe(1);
        expect(snapshot.items[0].terminalState).toBe("failed");
        expect(record.terminals).toEqual([{ id: "copy-failure", terminal: "failed" }]);
        expect(record.repositoryPatches.length).toBe(1);
        expect(record.cardPatches.length).toBe(1);
        expect(record.cardPatches[0].fields.terminalState).toBe("failed");
        expect(harness.state.unlinks).toContain(item.destinationMedia);
        expect(harness.state.bytesOf(item.sourcePath)).toEqual([1, 2, 3, 4, 5]);
        expect(item.stages.thumbnail.state).toBe("not-started");
        expect(harness.state.pendingTimerCount()).toBe(0);
        harness.scheduler.dispose();
    });
});

// ===========================================================================
// FFmpeg success / error / timeout / missing executable (Requirements 3.9, 7.3)
// ===========================================================================
describe("fast media ffmpeg fallback", function () {
    const destMedia = "C:/library/footage/asset/clip.mp4";
    const categoryDir = "C:/library/footage/asset";

    test("successful FFmpeg work reports generated derivatives and releases every timer", async function () {
        const harness = createHarness();
        harness.state.write(destMedia, [1, 2, 3]);
        const result = await harness.workers.runFfmpegFallback(destMedia, categoryDir, "asset", null);
        expect(result.ok).toBe(true);
        expect(result.status).toBe("generated");
        expect(result.proxyPath).toBe(categoryDir + "/proxy.mp4");
        expect(result.thumbnailPath).toBe(categoryDir + "/thumbnail.png");
        expect(harness.state.children.length).toBe(2);
        expect(harness.state.children[0].args).toEqual(expect.arrayContaining([
            "-vf", "scale=320:180:force_original_aspect_ratio=decrease",
        ]));
        expect(harness.state.pendingTimerCount()).toBe(0);
        expect(harness.workers.ownedChildren().length).toBe(0);
        harness.scheduler.dispose();
    });

    test("failing FFmpeg work reports derivative-unavailable without throwing", async function () {
        const harness = createHarness({ ffmpegPlan: ["error", "error"] });
        harness.state.write(destMedia, [1, 2, 3]);
        const result = await harness.workers.runFfmpegFallback(destMedia, categoryDir, "asset", null);
        expect(result.ok).toBe(false);
        expect(result.status).toBe("derivative-unavailable");
        expect(result.reason).toBe("ffmpeg-failed");
        expect(harness.state.pendingTimerCount()).toBe(0);
        expect(harness.workers.ownedChildren().length).toBe(0);
        harness.scheduler.dispose();
    });

    test("stalled FFmpeg work is killed by the 60-second timeout", async function () {
        const harness = createHarness({ ffmpegPlan: ["hang", "hang"] });
        harness.state.write(destMedia, [1, 2, 3]);
        const pending = harness.workers.runFfmpegFallback(destMedia, categoryDir, "asset", null);

        await waitFor(function () { return harness.state.children.length === 1; }, "thumbnail ffmpeg child");
        expect(harness.workers.ffmpegTimeoutMs).toBe(FFMPEG_TIMEOUT_MS);
        expect(harness.state.fireDelay(FFMPEG_TIMEOUT_MS)).toBe(1);
        await waitFor(function () { return harness.state.children.length === 2; }, "proxy ffmpeg child");
        expect(harness.state.fireDelay(FFMPEG_TIMEOUT_MS)).toBe(1);

        const result = await pending;
        expect(result.ok).toBe(false);
        expect(result.status).toBe("derivative-unavailable");
        expect(result.reason).toBe("ffmpeg-timeout");
        expect(harness.state.children[0].killed).toBe(true);
        expect(harness.state.children[1].killed).toBe(true);
        expect(harness.state.pendingTimerCount()).toBe(0);
        expect(harness.workers.ownedChildren().length).toBe(0);
        harness.scheduler.dispose();
    });

    test("a missing FFmpeg executable reports derivative-unavailable and spawns nothing", async function () {
        const harness = createHarness({ ffmpegExecutable: "" });
        harness.state.write(destMedia, [1, 2, 3]);
        const result = await harness.workers.runFfmpegFallback(destMedia, categoryDir, "asset", null);
        expect(result).toEqual({ ok: false, status: "derivative-unavailable", reason: "ffmpeg-unavailable" });
        expect(harness.state.children.length).toBe(0);
        expect(harness.state.pendingTimerCount()).toBe(0);
        harness.scheduler.dispose();
    });

    test("a missing FFmpeg executable keeps the copied original usable (Requirement 7.3)", async function () {
        const harness = createHarness({ videoDecode: "error", ffmpegExecutable: "" });
        const record = createCoordinator(harness);
        const bytes = [3, 5, 7, 11, 13, 17, 19, 23];
        const item = createItem(harness, { id: "no-ffmpeg", bytes: bytes });
        const snapshot = await record.coordinator.submitBatch({ id: "batch-no-ffmpeg", items: [item] });
        await settleScheduler(harness);

        expect(snapshot.terminalCount).toBe(1);
        expect(snapshot.items[0].terminalState).toBe("ready");
        expect(record.terminals).toEqual([{ id: "no-ffmpeg", terminal: "ready" }]);
        // The streamed copy of the original survives, byte for byte, and is still referenced.
        expect(harness.state.bytesOf(item.destinationMedia)).toEqual(bytes);
        expect(harness.state.bytesOf(item.sourcePath)).toEqual(bytes);
        expect(harness.state.unlinks).not.toContain(item.destinationMedia);
        const fields = record.repositoryPatches[0].fields;
        expect(fields.mediaFile).toBe(item.destinationMedia);
        expect(fields.derivativeStatus).toBe("derivative-unavailable");
        expect(fields.thumbStatus).toBe("ready");
        expect(fields.thumbnailPath).toBe(item.destinationThumbnail);
        expect(record.cardPatches[0].fields.mediaFile).toBe(item.destinationMedia);
        expect(item.completedResults.thumbnail.fallback).toBe(true);
        expect(harness.state.children.length).toBe(0);
        expect(harness.state.pendingTimerCount()).toBe(0);
        harness.scheduler.dispose();
    });
});

// ===========================================================================
// Disposal during every worker stage (Requirements 3.9, 4.6, 5.1-5.3, 7.1)
// ===========================================================================
describe("fast media disposal during worker stages", function () {
    test("disposal during the copy stage destroys streams, removes partial output and settles once", async function () {
        const harness = createHarness({ autoCopy: false });
        const record = createCoordinator(harness);
        const bytes = [9, 8, 7, 6, 5, 4, 3, 2, 1];
        const item = createItem(harness, { id: "dispose-copy", bytes: bytes });
        const batch = record.coordinator.submitBatch({ id: "batch-dispose-copy", items: [item] });

        await waitFor(function () { return harness.state.streams.length === 2; }, "copy streams opened");
        expect(harness.FastMedia.dispose()).toBe(true);
        const snapshot = await batch;
        await settleScheduler(harness);

        const readStream = harness.state.streams[0];
        const writeStream = harness.state.streams[1];
        expect(readStream.destroyed).toBe(true);
        expect(writeStream.destroyed).toBe(true);
        expect(harness.state.unlinks).toContain(item.destinationMedia);
        expect(harness.state.bytesOf(item.sourcePath)).toEqual(bytes);
        expect(snapshot.idle).toBe(true);
        expect(snapshot.terminalCount).toBe(1);
        expect(record.terminals.length).toBe(0);
        expect(item.terminalState).toBe("failed");
        expect(record.repositoryPatches.length).toBe(1);
        expect(record.cardPatches.length).toBe(1);
        expect(record.cardsDisposed).toBe(true);
        expect(harness.state.pendingTimerCount()).toBe(0);
        expect(harness.workers.unfinishedThumbnails().length).toBe(0);
        const lanes = harness.scheduler.snapshot().lanes;
        expect({ active: lanes.filesystem.active, pending: lanes.filesystem.pending }).toEqual({ active: 0, pending: 0 });
        harness.scheduler.dispose();
    });

    test("disposal during the decode stage releases the decoder, listeners and timers", async function () {
        const harness = createHarness({ videoDecode: "manual" });
        const record = createCoordinator(harness);
        const item = createItem(harness, { id: "dispose-decode" });
        const batch = record.coordinator.submitBatch({ id: "batch-dispose-decode", items: [item] });

        await waitFor(function () { return harness.state.videos.length === 1; }, "decoder created");
        const video = harness.state.videos[0];
        expect(harness.state.pendingTimerCount()).toBeGreaterThanOrEqual(1);
        expect(harness.workers.unfinishedThumbnails().length).toBe(1);

        expect(harness.FastMedia.dispose()).toBe(true);
        const snapshot = await batch;
        await settleScheduler(harness);

        expect(video.pauseCalls).toBeGreaterThanOrEqual(1);
        expect(video.removedAttributes).toContain("src");
        expect(video.target.count()).toBe(0);
        expect(harness.state.revokedUrls.length).toBe(harness.state.createdUrls.length);
        expect(harness.workers.unfinishedThumbnails().length).toBe(0);
        expect(harness.state.pendingTimerCount()).toBe(0);
        expect(snapshot.idle).toBe(true);
        expect(snapshot.terminalCount).toBe(1);
        expect(item.terminalState).toBe("failed");
        expect(harness.state.writes).toEqual([]);
        const lanes = harness.scheduler.snapshot().lanes;
        expect({ active: lanes.thumbnail.active, pending: lanes.thumbnail.pending }).toEqual({ active: 0, pending: 0 });
        harness.scheduler.dispose();
    });

    test("disposal during the FFmpeg stage kills the process and releases its handle", async function () {
        const harness = createHarness({ ffmpegPlan: ["hang", "hang"] });
        const record = createCoordinator(harness, {
            workers: {
                thumbnail: function (workItem) {
                    return Promise.resolve({
                        ok: true,
                        path: workItem.destinationThumbnail,
                        status: "available",
                        needsFfmpeg: true,
                    });
                },
            },
        });
        const item = createItem(harness, { id: "dispose-ffmpeg" });
        const batch = record.coordinator.submitBatch({ id: "batch-dispose-ffmpeg", items: [item] });

        await waitFor(function () { return harness.state.children.length === 1; }, "ffmpeg child spawned");
        expect(harness.workers.ownedChildren().length).toBe(1);

        expect(harness.FastMedia.dispose()).toBe(true);
        const snapshot = await batch;
        await settleScheduler(harness);

        expect(harness.state.children[0].killed).toBe(true);
        expect(harness.workers.ownedChildren().length).toBe(0);
        expect(harness.state.pendingTimerCount()).toBe(0);
        expect(snapshot.idle).toBe(true);
        expect(snapshot.terminalCount).toBe(1);
        expect(item.terminalState).toBe("failed");
        const schedulerSnapshot = harness.scheduler.snapshot();
        expect(schedulerSnapshot.processes).toBe(0);
        expect({
            active: schedulerSnapshot.lanes.ffmpeg.active,
            pending: schedulerSnapshot.lanes.ffmpeg.pending,
        }).toEqual({ active: 0, pending: 0 });
        harness.scheduler.dispose();
    });
});
