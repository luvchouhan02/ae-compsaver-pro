"use strict";

const nodeFs = require("fs");
const path = require("path");
const vm = require("vm");
const fc = require("fast-check");
const schedulerModule = require(path.resolve(__dirname, "../js/core/scheduler.js"));

const ROOT = path.resolve(__dirname, "..");
const ENGINE_SOURCE = nodeFs.readFileSync(path.join(ROOT, "js/core/fastMediaEngine.js"), "utf8");
const ENGINE_SCRIPT = new vm.Script(ENGINE_SOURCE, { filename: "fastMediaEngine.js" });

function fakeEmitter() {
    const handlers = {};
    return {
        handlers,
        on: function (event, handler) {
            (handlers[event] = handlers[event] || []).push(handler);
            return this;
        },
        emit: function (event, value) {
            const list = (handlers[event] || []).slice();
            for (let i = 0; i < list.length; i++) list[i](value);
            return list.length > 0;
        },
    };
}

/**
 * Fake filesystem whose streams record the owning scheduler lane at every open and close,
 * so copy work can be checked for filesystem-lane ownership without touching a real disk.
 */
function createFakeFilesystem(sourcePath, sourceBytes) {
    const state = {
        files: {},
        opens: [],
        closes: [],
        writeTargets: [],
        unlinks: [],
        syncCalls: [],
        mkdirs: [],
        observe: function () { return null; },
    };
    state.files[sourcePath] = sourceBytes.slice();

    function laneView() {
        const snapshot = state.observe();
        const lanes = (snapshot && snapshot.lanes) || {};
        return {
            filesystem: lanes.filesystem ? lanes.filesystem.active : -1,
            thumbnail: lanes.thumbnail ? lanes.thumbnail.active : -1,
            ffmpeg: lanes.ffmpeg ? lanes.ffmpeg.active : -1,
        };
    }

    function recordSync(name, target) {
        state.syncCalls.push([name, target]);
    }

    state.fs = {
        promises: {
            mkdir: async function (target) { state.mkdirs.push(target); },
            stat: async function (target) {
                if (!state.files[target]) throw new Error("ENOENT: " + target);
                return { size: state.files[target].length };
            },
            unlink: async function (target) {
                await null;
                state.unlinks.push(target);
                delete state.files[target];
            },
            writeFile: async function (target) { state.writeTargets.push(["writeFile", target]); },
            copyFile: async function (from, to) { state.writeTargets.push(["copyFile", to]); },
        },
        createReadStream: function (target) {
            const stream = fakeEmitter();
            state.opens.push({ mode: "read", path: target, lanes: laneView() });
            stream.destroyed = false;
            stream.destroy = function () {
                if (stream.destroyed) return;
                stream.destroyed = true;
                state.closes.push({ mode: "read", path: target, lanes: laneView() });
            };
            stream.pipe = function (writer) {
                const chunks = state.pendingChunks || [];
                const failAt = state.failIndex;
                function step(index) {
                    if (stream.destroyed || writer.destroyed || writer.ended) return;
                    if (state.failTarget && index === failAt) {
                        const error = new Error("injected " + state.failTarget + " stream error");
                        if (state.failTarget === "read") stream.emit("error", error);
                        else writer.emit("error", error);
                        return;
                    }
                    if (index >= chunks.length) {
                        writer.end();
                        return;
                    }
                    writer.write(chunks[index]);
                    Promise.resolve().then(function () { step(index + 1); });
                }
                Promise.resolve().then(function () { step(0); });
                return writer;
            };
            return stream;
        },
        createWriteStream: function (target) {
            const stream = fakeEmitter();
            state.opens.push({ mode: "write", path: target, lanes: laneView() });
            state.writeTargets.push(["createWriteStream", target]);
            state.files[target] = [];
            stream.destroyed = false;
            stream.ended = false;
            stream.write = function (chunk) {
                if (stream.destroyed || stream.ended) return false;
                const bytes = state.files[target] || (state.files[target] = []);
                for (let i = 0; i < chunk.length; i++) bytes.push(chunk[i]);
                return true;
            };
            stream.end = function () {
                if (stream.ended || stream.destroyed) return;
                stream.ended = true;
                state.closes.push({ mode: "write", path: target, lanes: laneView() });
                stream.emit("close");
            };
            stream.destroy = function () {
                if (stream.destroyed) return;
                stream.destroyed = true;
                if (!stream.ended) state.closes.push({ mode: "write", path: target, lanes: laneView() });
            };
            return stream;
        },
        existsSync: function (target) { recordSync("existsSync", target); return !!state.files[target]; },
        statSync: function (target) { recordSync("statSync", target); return { size: (state.files[target] || []).length }; },
        readFileSync: function (target) { recordSync("readFileSync", target); return ""; },
        writeFileSync: function (target) { recordSync("writeFileSync", target); state.writeTargets.push(["writeFileSync", target]); },
        copyFileSync: function (from, to) { recordSync("copyFileSync", to); state.writeTargets.push(["copyFileSync", to]); },
        unlinkSync: function (target) { recordSync("unlinkSync", target); delete state.files[target]; },
        readdirSync: function (target) { recordSync("readdirSync", target); return []; },
        mkdirSync: function (target) { recordSync("mkdirSync", target); },
    };
    return state;
}

function loadEngine(fakeFs) {
    const context = {
        window: {
            rootPath: "C:/library",
            addEventListener: function () { },
            removeEventListener: function () { },
            URL: { createObjectURL: function () { return ""; }, revokeObjectURL: function () { } },
        },
        document: {
            getElementById: function () { return null; },
            querySelector: function () { return null; },
            querySelectorAll: function () { return []; },
            createElement: function () { throw new Error("streamed copy must not create media elements"); },
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
    if (typeof context.window.MediaWorkCoordinator !== "function") {
        throw new Error("MediaWorkCoordinator was not exposed by the media engine");
    }
    return context.window;
}

function partition(bytes, sizes) {
    const chunks = [];
    let offset = 0;
    let index = 0;
    while (offset < bytes.length) {
        const size = sizes[index % sizes.length];
        chunks.push(Buffer.from(bytes.slice(offset, offset + size)));
        offset += size;
        index++;
    }
    return chunks;
}

async function runStreamedCopy(scenario) {
    const sourcePath = "C:/originals/" + scenario.sourceName;
    const destinationFolder = "C:/library/footage/asset";
    const destinationMedia = destinationFolder + "/" + scenario.sourceName;
    const state = createFakeFilesystem(sourcePath, scenario.bytes);
    const chunks = partition(scenario.bytes, scenario.chunkSizes);
    state.pendingChunks = chunks;
    state.failTarget = scenario.failure ? scenario.failure.target : null;
    state.failIndex = scenario.failure ? Math.min(scenario.failure.atChunk, chunks.length) : -1;

    const scheduler = schedulerModule.createScheduler();
    state.observe = function () { return scheduler.snapshot(); };
    const engine = loadEngine(state.fs);
    const commits = [];
    const coordinator = new engine.MediaWorkCoordinator({
        scheduler: scheduler,
        repository: {
            patchById: function (id, fields) {
                commits.push({ id: id, fields: fields });
                return Promise.resolve({ ok: true });
            },
        },
        workers: {
            thumbnail: function () {
                return Promise.resolve({ ok: true, path: destinationFolder + "/thumb.png", status: "available" });
            },
            ffmpeg: function () { return Promise.resolve({ ok: true }); },
        },
        progressIntervalMs: 100000,
    });

    const item = {
        id: "media-copy-1",
        sourcePath: sourcePath,
        fileName: scenario.sourceName,
        safeName: "asset",
        isVideo: false,
        destinationFolder: destinationFolder,
        destinationMedia: destinationMedia,
        destinationThumbnail: destinationFolder + "/thumb.png",
    };

    let snapshot = null;
    try {
        snapshot = await coordinator.submitBatch({ id: "batch-copy", items: [item] });
    } finally {
        coordinator.dispose("test complete");
        await scheduler.drain("filesystem");
        scheduler.dispose();
    }

    return {
        state: state,
        snapshot: snapshot,
        commits: commits,
        sourcePath: sourcePath,
        destinationMedia: destinationMedia,
        laneIdle: scheduler.snapshot().lanes.filesystem,
    };
}

function assertStreamedCopy(scenario, run) {
    const state = run.state;
    const stageState = run.snapshot.items[0].stages.copy.state;
    const readOpens = state.opens.filter(function (entry) { return entry.mode === "read"; });
    const writeOpens = state.opens.filter(function (entry) { return entry.mode === "write"; });

    // The copy uses exactly one owned read stream on the source and one owned write stream on the destination.
    expect(readOpens.map(function (entry) { return entry.path; })).toEqual([run.sourcePath]);
    expect(writeOpens.map(function (entry) { return entry.path; })).toEqual([run.destinationMedia]);

    // The source is never opened, written, copied over, or removed by any filesystem API.
    state.writeTargets.forEach(function (entry) { expect(entry[1]).not.toBe(run.sourcePath); });
    expect(state.unlinks).not.toContain(run.sourcePath);
    expect(state.syncCalls).toEqual([]);

    // Every open and close happens while the filesystem lane, and only that lane, owns the work.
    state.opens.concat(state.closes).forEach(function (entry) {
        expect(entry.lanes.filesystem).toBe(1);
        expect(entry.lanes.thumbnail).toBe(0);
        expect(entry.lanes.ffmpeg).toBe(0);
    });
    expect(state.closes.length).toBe(state.opens.length);
    expect(run.laneIdle.active).toBe(0);
    expect(run.laneIdle.pending).toBe(0);

    // The source path, byte length, and byte sequence survive success and failure alike.
    expect(Object.prototype.hasOwnProperty.call(state.files, run.sourcePath)).toBe(true);
    expect(state.files[run.sourcePath].length).toBe(scenario.bytes.length);
    expect(state.files[run.sourcePath].join(",")).toBe(scenario.bytes.join(","));

    if (scenario.failure) {
        expect(stageState).toBe("failed");
        expect(run.snapshot.items[0].terminalState).toBe("failed");
        // Partial destination output is removed through the asynchronous unlink API.
        expect(state.unlinks).toContain(run.destinationMedia);
        expect(Object.prototype.hasOwnProperty.call(state.files, run.destinationMedia)).toBe(false);
    } else {
        expect(stageState).toBe("succeeded");
        expect(run.snapshot.items[0].terminalState).toBe("ready");
        expect(state.files[run.destinationMedia].join(",")).toBe(scenario.bytes.join(","));
    }
}

const scenarioArbitrary = fc.record({
    bytes: fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 48 }),
    chunkSizes: fc.array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 6 }),
    sourceName: fc.constantFrom("clip.mp4", "still.png", "take one.mov", "frame'1.jpg"),
    failure: fc.option(
        fc.record({ target: fc.constantFrom("read", "write"), atChunk: fc.nat({ max: 10 }) }),
        { nil: null, freq: 1 }
    ),
});

describe("Media streamed copy async I/O properties", function () {
    test("streamed copies preserve the original source file", async function () {
        /**
         * Feature: media-engine-lag, Property 13: Streamed copies preserve the original
         * **Validates: Requirements 5.1, 7.1**
         */
        await fc.assert(fc.asyncProperty(scenarioArbitrary, async function (scenario) {
            assertStreamedCopy(scenario, await runStreamedCopy(scenario));
        }), { seed: 61004, numRuns: 100 });
    }, 120000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 14 harness — hot-callback synchronous-filesystem exclusion
//
// What is under test
// ------------------
// The REAL Fast Media production wiring in js/core/fastMediaEngine.js, driven
// end to end from the REAL CEP picker-completion callback through the REAL
// scheduler-job, thumbnail, FFmpeg, and keyed-card-patch callbacks. The engine
// receives an instrumented `fs` whose every `*Sync` function records its call
// instead of touching a disk, so a single synchronous existence/status/read/
// write/copy/enumeration call anywhere in those callbacks is observable.
//
// Promises inside the engine realm are replaced by a deterministic
// synchronously-settling implementation so a whole import (picker result →
// copy → thumbnail/decode → FFmpeg fallback → repository commit → keyed card
// patch) completes inside one synchronous predicate. Nothing about which
// filesystem API the engine reaches for changes with promise timing.
// ─────────────────────────────────────────────────────────────────────────────

const { MediaEntryRepository, commitVerifiedLocalStorage, libraryIndexPayloadVerifies } = require(path.resolve(__dirname, "../js/core/persistence.js"));
const { KeyedMediaCardHelper } = require(path.resolve(__dirname, "../js/core/keyedMediaCardHelper.js"));
const { loadHelpers } = require(path.resolve(__dirname, "./helpers/loadHelpers.js"));
const { createMiniDocument } = require(path.resolve(__dirname, "./helpers/miniDom.js"));

const P14_LIBRARY_ROOT = "C:/library";
const P14_SOURCE_FOLDER = "C:/originals";

// Every synchronous filesystem entry point Requirement 5.2 forbids in a hot
// callback, plus the neighbouring `*Sync` surface a regression could reach for.
const P14_SYNC_FS_METHODS = [
    "existsSync", "statSync", "lstatSync", "fstatSync", "accessSync", "readFileSync",
    "writeFileSync", "appendFileSync", "copyFileSync", "cpSync", "renameSync", "unlinkSync",
    "rmSync", "rmdirSync", "mkdirSync", "mkdtempSync", "readdirSync", "opendirSync",
    "realpathSync", "readlinkSync", "symlinkSync", "linkSync", "openSync", "closeSync",
    "readSync", "writeSync", "truncateSync", "ftruncateSync", "chmodSync", "chownSync",
    "utimesSync", "globSync", "statfsSync",
];

const p14Constants = loadHelpers({ file: path.join("js", "core", "constants.js") });
const p14Utils = loadHelpers({
    file: path.join("js", "core", "utils.js"),
    injected: {
        SECTIONS: p14Constants.get("SECTIONS"),
        IMAGE_SECTIONS: p14Constants.get("IMAGE_SECTIONS"),
    },
});
const p14Templates = loadHelpers({
    file: path.join("js", "templates", "templates.js"),
    injected: {
        SECTIONS: p14Constants.get("SECTIONS"),
        IMAGE_SECTIONS: p14Constants.get("IMAGE_SECTIONS"),
        escapeAttr: p14Utils.get("escapeAttr"),
        escapeHTML: p14Utils.get("escapeHTML"),
        nfs: function () { return { existsSync: function () { return false; } }; },
        allTemplates: [],
        showToast: function () { },
        rootPath: "",
    },
});
const p14RenderCardMarkup = p14Templates.get("renderTemplateCardMarkup");
if (typeof p14RenderCardMarkup !== "function") {
    throw new Error("Property 14 requires the shared card markup from js/templates/templates.js");
}

/** Deterministic promise whose reactions run at settle time, with no microtask hop. */
function p14CreateSyncPromise() {
    function SyncPromise(executor) {
        const self = this;
        this._state = "pending";
        this._value = undefined;
        this._queue = [];
        function settle(state, value) {
            if (self._state !== "pending") return;
            if (state === "fulfilled" && value && (typeof value === "object" || typeof value === "function") &&
                typeof value.then === "function") {
                let adopted = false;
                try {
                    value.then(function (inner) { if (!adopted) { adopted = true; settle("fulfilled", inner); } },
                        function (error) { if (!adopted) { adopted = true; settle("rejected", error); } });
                } catch (error) {
                    if (!adopted) { adopted = true; settle("rejected", error); }
                }
                return;
            }
            self._state = state;
            self._value = value;
            const queue = self._queue.splice(0);
            for (let i = 0; i < queue.length; i++) queue[i]();
        }
        try {
            executor(function (value) { settle("fulfilled", value); }, function (error) { settle("rejected", error); });
        } catch (error) {
            settle("rejected", error);
        }
    }
    SyncPromise.prototype.then = function (onFulfilled, onRejected) {
        const self = this;
        return new SyncPromise(function (resolve, reject) {
            function run() {
                try {
                    if (self._state === "fulfilled") {
                        resolve(typeof onFulfilled === "function" ? onFulfilled(self._value) : self._value);
                    } else if (typeof onRejected === "function") {
                        resolve(onRejected(self._value));
                    } else {
                        reject(self._value);
                    }
                } catch (error) { reject(error); }
            }
            if (self._state === "pending") self._queue.push(run);
            else run();
        });
    };
    SyncPromise.prototype.catch = function (onRejected) { return this.then(undefined, onRejected); };
    SyncPromise.prototype.finally = function (handler) {
        return this.then(function (value) { handler(); return value; },
            function (error) { handler(); throw error; });
    };
    SyncPromise.resolve = function (value) {
        return value instanceof SyncPromise ? value : new SyncPromise(function (resolve) { resolve(value); });
    };
    SyncPromise.reject = function (error) {
        return new SyncPromise(function (ignore, reject) { reject(error); });
    };
    SyncPromise.all = function (values) {
        const list = Array.prototype.slice.call(values || []);
        return new SyncPromise(function (resolve, reject) {
            const results = new Array(list.length);
            let remaining = list.length;
            if (!remaining) { resolve(results); return; }
            for (let i = 0; i < list.length; i++) {
                (function (index) {
                    SyncPromise.resolve(list[index]).then(function (value) {
                        results[index] = value;
                        remaining--;
                        if (remaining === 0) resolve(results);
                    }, reject);
                })(i);
            }
        });
    };
    SyncPromise.race = function (values) {
        const list = Array.prototype.slice.call(values || []);
        return new SyncPromise(function (resolve, reject) {
            for (let i = 0; i < list.length; i++) SyncPromise.resolve(list[i]).then(resolve, reject);
        });
    };
    return SyncPromise;
}

/**
 * Instrumented in-memory filesystem: asynchronous APIs work, every `*Sync`
 * function only records the call it was asked to make.
 */
function p14CreateFilesystem(SyncPromise, scenario) {
    const nodes = {};
    let clock = 1;
    const state = { syncCalls: [], writes: [], unlinks: [], mkdirs: [], nodes: nodes, fs: null };

    function normalize(target) {
        const value = String(target === undefined || target === null ? "" : target).replace(/\\/g, "/");
        return value.length > 1 ? value.replace(/\/+$/, "") : value;
    }
    function addDirectory(target) {
        const parts = normalize(target).split("/");
        let current = "";
        for (let i = 0; i < parts.length; i++) {
            current = current ? current + "/" + parts[i] : parts[i];
            if (!current) continue;
            if (!nodes[current]) nodes[current] = { dir: true, bytes: [], mtimeMs: clock++ };
        }
    }
    function addFile(target, size) {
        const normalized = normalize(target);
        const parent = normalized.substring(0, normalized.lastIndexOf("/"));
        if (parent) addDirectory(parent);
        const bytes = [];
        for (let i = 0; i < size; i++) bytes.push((i * 7 + 11) % 256);
        nodes[normalized] = { dir: false, bytes: bytes, mtimeMs: clock++ };
        return normalized;
    }
    function statsFor(node) {
        return {
            size: node.dir ? 0 : node.bytes.length,
            mtimeMs: node.mtimeMs,
            mtime: new Date(node.mtimeMs),
            isDirectory: function () { return node.dir === true; },
            isFile: function () { return node.dir !== true; },
        };
    }
    function statOf(target) {
        const normalized = normalize(target);
        if (nodes[normalized]) return statsFor(nodes[normalized]);
        // A warm proxy cache is an outcome of its own: FFmpeg must then reuse it.
        if (scenario.proxyCached && /\/proxy\.mp4$/.test(normalized)) {
            return statsFor({ dir: false, bytes: [1, 2, 3], mtimeMs: Number.MAX_SAFE_INTEGER });
        }
        return null;
    }
    function readDirOf(target) {
        const prefix = normalize(target) + "/";
        const names = [];
        const keys = Object.keys(nodes);
        for (let i = 0; i < keys.length; i++) {
            if (keys[i].indexOf(prefix) !== 0) continue;
            const rest = keys[i].substring(prefix.length);
            if (rest && rest.indexOf("/") === -1) names.push(rest);
        }
        return names;
    }
    function emitter() {
        const handlers = {};
        return {
            on: function (event, handler) {
                (handlers[event] = handlers[event] || []).push(handler);
                return this;
            },
            emit: function (event, value) {
                const list = (handlers[event] || []).slice();
                for (let i = 0; i < list.length; i++) list[i](value);
                return list.length > 0;
            },
        };
    }

    const api = {
        promises: {
            mkdir: function (target) {
                state.mkdirs.push(normalize(target));
                addDirectory(target);
                return SyncPromise.resolve();
            },
            stat: function (target) {
                const stats = statOf(target);
                return stats ? SyncPromise.resolve(stats) : SyncPromise.reject(new Error("ENOENT: " + target));
            },
            readdir: function (target) { return SyncPromise.resolve(readDirOf(target)); },
            unlink: function (target) {
                state.unlinks.push(normalize(target));
                delete nodes[normalize(target)];
                return SyncPromise.resolve();
            },
            writeFile: function (target, data, encoding) {
                state.writes.push({ op: "writeFile", target: normalize(target), encoding: encoding || "" });
                addFile(target, String(data === undefined || data === null ? "" : data).length);
                return SyncPromise.resolve();
            },
            copyFile: function (from, to) {
                state.writes.push({ op: "copyFile", target: normalize(to) });
                const source = nodes[normalize(from)];
                nodes[normalize(to)] = { dir: false, bytes: source ? source.bytes.slice() : [], mtimeMs: clock++ };
                return SyncPromise.resolve();
            },
        },
        stat: function (target, callback) {
            const stats = statOf(target);
            callback(stats ? null : new Error("ENOENT: " + target), stats || null);
        },
        readdir: function (target, callback) { callback(null, readDirOf(target)); },
        mkdir: function (target, options, callback) {
            state.mkdirs.push(normalize(target));
            addDirectory(target);
            (typeof options === "function" ? options : callback)(null);
        },
        unlink: function (target, callback) {
            state.unlinks.push(normalize(target));
            delete nodes[normalize(target)];
            callback(null);
        },
        writeFile: function (target, data, encoding, callback) {
            state.writes.push({ op: "writeFile", target: normalize(target), encoding: encoding || "" });
            addFile(target, String(data === undefined || data === null ? "" : data).length);
            (typeof encoding === "function" ? encoding : callback)(null);
        },
        createReadStream: function (target) {
            const stream = emitter();
            const normalized = normalize(target);
            stream.destroyed = false;
            stream.destroy = function () { stream.destroyed = true; };
            stream.pipe = function (writer) {
                const node = nodes[normalized];
                if (!node || node.dir) {
                    stream.emit("error", new Error("ENOENT: " + normalized));
                    return writer;
                }
                const bytes = node.bytes;
                const chunkSize = 7;
                const failAt = scenario.copyFailAtChunk;
                let chunkIndex = 0;
                for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                    if (stream.destroyed || writer.destroyed || writer.ended) return writer;
                    if (scenario.copyOutcome === "read-error" && chunkIndex >= failAt) {
                        stream.emit("error", new Error("injected read stream error"));
                        return writer;
                    }
                    if (scenario.copyOutcome === "write-error" && chunkIndex >= failAt) {
                        writer.emit("error", new Error("injected write stream error"));
                        return writer;
                    }
                    writer.write(bytes.slice(offset, offset + chunkSize));
                    chunkIndex++;
                }
                if (scenario.copyOutcome === "read-error") {
                    stream.emit("error", new Error("injected read stream error"));
                    return writer;
                }
                if (scenario.copyOutcome === "write-error") {
                    writer.emit("error", new Error("injected write stream error"));
                    return writer;
                }
                writer.end();
                return writer;
            };
            return stream;
        },
        createWriteStream: function (target) {
            const stream = emitter();
            const normalized = normalize(target);
            state.writes.push({ op: "createWriteStream", target: normalized });
            nodes[normalized] = { dir: false, bytes: [], mtimeMs: clock++ };
            stream.destroyed = false;
            stream.ended = false;
            stream.write = function (chunk) {
                if (stream.destroyed || stream.ended) return false;
                const node = nodes[normalized] || (nodes[normalized] = { dir: false, bytes: [], mtimeMs: clock++ });
                for (let i = 0; i < chunk.length; i++) node.bytes.push(chunk[i]);
                return true;
            };
            stream.end = function () {
                if (stream.ended || stream.destroyed) return;
                stream.ended = true;
                stream.emit("close");
            };
            stream.destroy = function () { stream.destroyed = true; };
            return stream;
        },
    };

    for (let i = 0; i < P14_SYNC_FS_METHODS.length; i++) {
        (function (name) {
            api[name] = function (target) {
                state.syncCalls.push(name + "(" + normalize(target) + ")");
                if (name === "existsSync") return false;
                if (name === "readdirSync") return [];
                if (name === "readFileSync") return "";
                if (name === "statSync" || name === "lstatSync") {
                    return statOf(target) || statsFor({ dir: false, bytes: [], mtimeMs: 0 });
                }
                return undefined;
            };
        })(P14_SYNC_FS_METHODS[i]);
    }

    state.fs = api;
    state.addFile = addFile;
    state.addDirectory = addDirectory;
    state.normalize = normalize;
    return state;
}

/** Canvas/video/image doubles whose decode events fire synchronously. */
function p14CreateMediaFakes(scenario, evidence, hooks) {
    function listenerTarget() {
        const listeners = {};
        return {
            addEventListener: function (name, listener) { (listeners[name] = listeners[name] || []).push(listener); },
            removeEventListener: function (name, listener) {
                const bucket = listeners[name] || [];
                const at = bucket.indexOf(listener);
                if (at !== -1) bucket.splice(at, 1);
            },
            dispatch: function (name) {
                const bucket = (listeners[name] || []).slice();
                for (let i = 0; i < bucket.length; i++) bucket[i]({ type: name });
            },
        };
    }
    function createCanvas() {
        evidence.canvases++;
        if (typeof hooks.onCanvas === "function") hooks.onCanvas();
        let width = 0;
        let height = 0;
        const context = {
            fillStyle: "", font: "", textAlign: "",
            drawImage: function () { }, fillRect: function () { }, fillText: function () { },
            beginPath: function () { }, moveTo: function () { }, lineTo: function () { },
            closePath: function () { }, fill: function () { },
        };
        const canvas = {
            getContext: function () { return scenario.canvasContext === "missing" ? null : context; },
            toDataURL: function () { return "data:image/png;base64,UDE0"; },
        };
        Object.defineProperty(canvas, "width", { get: function () { return width; }, set: function (v) { width = v; } });
        Object.defineProperty(canvas, "height", { get: function () { return height; }, set: function (v) { height = v; } });
        return canvas;
    }
    function createVideo() {
        evidence.videos++;
        const target = listenerTarget();
        const video = {
            muted: false, crossOrigin: "", duration: 12, videoWidth: 1280, videoHeight: 720, parentNode: null,
            addEventListener: target.addEventListener,
            removeEventListener: target.removeEventListener,
            pause: function () { }, load: function () { }, removeAttribute: function () { },
            setAttribute: function () { },
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
                target.dispatch(scenario.decodeOutcome === "error" ? "error" : "loadeddata");
            },
        });
        return video;
    }
    function createImage() {
        evidence.images++;
        const target = listenerTarget();
        const image = {
            naturalWidth: 900, naturalHeight: 600, width: 900, height: 600,
            onload: null, onerror: null,
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
                target.dispatch(scenario.decodeOutcome === "error" ? "error" : "load");
            },
        });
        return image;
    }
    return {
        createElement: function (tag) {
            const name = String(tag).toLowerCase();
            if (name === "canvas") return createCanvas();
            if (name === "video") return createVideo();
            return null;
        },
        Image: createImage,
    };
}

function p14CreateButton() {
    const handlers = {};
    return {
        handlers: handlers,
        addEventListener: function (name, handler) { (handlers[name] = handlers[name] || []).push(handler); },
        removeEventListener: function (name, handler) {
            const bucket = handlers[name] || [];
            const at = bucket.indexOf(handler);
            if (at !== -1) bucket.splice(at, 1);
        },
    };
}

/** Panel document: real parsed DOM for cards, doubles for buttons and media elements. */
function p14CreateDocument(miniDocument, buttons, mediaFakes) {
    const documentFake = {
        createElement: function (tag) {
            const name = String(tag).toLowerCase();
            if (name === "canvas" || name === "video") return mediaFakes.createElement(name);
            return miniDocument.createElement(tag);
        },
        createDocumentFragment: function () { return miniDocument.createDocumentFragment(); },
        getElementById: function (id) {
            if (Object.prototype.hasOwnProperty.call(buttons, String(id))) return buttons[String(id)];
            return miniDocument.getElementById(id);
        },
        querySelector: function (selector) { return miniDocument.querySelector(selector); },
        querySelectorAll: function (selector) { return miniDocument.querySelectorAll(selector); },
    };
    Object.defineProperty(documentFake, "documentElement", { get: function () { return miniDocument.documentElement; } });
    Object.defineProperty(documentFake, "body", { get: function () { return miniDocument.body; } });
    return documentFake;
}

/** Recording media metrics: the observation point for every hot callback. */
function p14CreateMetrics(evidence) {
    return {
        start: function (kind) { evidence.scenarioStarts.push(kind); },
        stageStart: function (stage) { evidence.stageStarts.push(stage); },
        stageEnd: function (stage, mediaId, outcome) { evidence.stageEnds.push({ stage: stage, outcome: outcome }); },
        observeLane: function () { }, observeProcessCount: function () { },
        observeChildProcessCount: function () { }, observeDecoderCount: function () { },
        recordPickerResult: function () { evidence.pickerResults++; },
        recordDiscoveryComplete: function () { evidence.discoveries++; },
        recordCardVisible: function () { evidence.cardsVisible++; },
        phase: function (name, work) { evidence.phases.push(name); return work(); },
        recordCardPatch: function (ok) { evidence.cardPatches.push(!!ok); },
        finishScenario: function (detail) { evidence.finishes.push(detail); return null; },
        dispose: function () { evidence.metricsDisposed++; },
    };
}

/** Inline scheduler: lane ownership is Property 15's subject, timing is not this one's. */
function p14CreateScheduler(SyncPromise, evidence) {
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
    return {
        enqueue: function (lane, worker, options) {
            evidence.jobs.push({ lane: lane, stage: options && options.stage, mediaId: options && options.mediaId });
            let promise;
            try { promise = SyncPromise.resolve(worker(control)); }
            catch (error) { promise = SyncPromise.reject(error); }
            return { promise: promise, lane: lane, cancel: function () { return false; } };
        },
        defer: function (lane, worker, delay, options) { return this.enqueue(lane, worker, options); },
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
}

const P14_SUPPORTED = { ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image", ".mp4": "video", ".mov": "video", ".webm": "video", ".avi": "video" };

function p14Extension(name) {
    const at = String(name).lastIndexOf(".");
    return at === -1 ? "" : String(name).substring(at).toLowerCase();
}

/** What the real pipeline is expected to reach, derived from the scenario alone. */
function p14Expectations(scenario) {
    const selected = scenario.cancelled ? [] :
        (scenario.pickerMode === "folder" ? scenario.files.slice() : [scenario.files[0]]);
    const seen = {};
    const accepted = [];
    for (let i = 0; i < selected.length; i++) {
        const name = selected[i].name;
        const kind = P14_SUPPORTED[p14Extension(name)];
        if (!kind) continue;
        if (Object.prototype.hasOwnProperty.call(seen, name)) continue;
        seen[name] = true;
        accepted.push({ name: name, isVideo: kind === "video" });
    }
    const copySucceeds = scenario.copyOutcome === "success";
    const decodeFails = scenario.decodeOutcome === "error" || scenario.canvasContext === "missing";
    let expectsFfmpeg = false;
    for (let i = 0; i < accepted.length; i++) {
        if (accepted[i].isVideo && copySucceeds && decodeFails) expectsFfmpeg = true;
    }
    return {
        accepted: accepted,
        expectsImport: accepted.length > 0,
        expectsThumbnail: accepted.length > 0 && copySucceeds,
        expectsFfmpeg: expectsFfmpeg,
        expectsCopyFailure: accepted.length > 0 && !copySucceeds,
    };
}

/**
 * Drive the real production wiring: init → import-button click → picker
 * completion → copy/thumbnail/FFmpeg stage completion → repository commit →
 * keyed card patch, all inside one synchronous turn.
 */
function p14Run(scenario) {
    const SyncPromise = p14CreateSyncPromise();
    const evidence = {
        jobs: [], stageStarts: [], stageEnds: [], cardPatches: [], phases: [], finishes: [],
        scenarioStarts: [], toasts: [], frames: [], childProcesses: [],
        pickerResults: 0, discoveries: 0, cardsVisible: 0, metricsDisposed: 0,
        canvases: 0, images: 0, videos: 0, ffmpegResolutions: 0, ffmpegExecutions: 0,
    };
    const filesystem = p14CreateFilesystem(SyncPromise, scenario);
    filesystem.addDirectory(P14_LIBRARY_ROOT);
    filesystem.addDirectory(P14_SOURCE_FOLDER);
    for (let i = 0; i < scenario.files.length; i++) {
        filesystem.addFile(P14_SOURCE_FOLDER + "/" + scenario.files[i].name, scenario.files[i].size);
    }

    const miniDocument = createMiniDocument();
    const grid = miniDocument.createElement("div");
    grid.id = "footage-list-container";
    miniDocument.body.appendChild(grid);

    // Production wiring (Fix 4) funnels every repository commit through the
    // staged/verified localStorage ladder and FAILS LOUDLY when it is absent,
    // so the realm must carry the same ladder pieces index.html loads ahead
    // of fastMediaEngine.js: the two functions plus a localStorage host.
    const storageData = {};
    const localStorageStub = {
        getItem: function (key) {
            return Object.prototype.hasOwnProperty.call(storageData, key) ? storageData[key] : null;
        },
        setItem: function (key, value) { storageData[key] = String(value); },
        removeItem: function (key) { delete storageData[key]; },
    };

    let detached = false;
    const hooks = {
        onCanvas: function () {
            if (!scenario.detachCardDuringThumbnail || detached) return;
            detached = true;
            const cards = grid.children;
            if (cards.length) grid.removeChild(cards[0]);
        },
    };
    const mediaFakes = p14CreateMediaFakes(scenario, evidence, hooks);
    const buttons = { "btn-import-file": p14CreateButton(), "btn-import-folder": p14CreateButton() };
    const documentFake = p14CreateDocument(miniDocument, buttons, mediaFakes);
    const metrics = p14CreateMetrics(evidence);
    const scheduler = p14CreateScheduler(SyncPromise, evidence);
    const pickerCallbacks = [];
    const timers = {};
    let timerId = 0;

    const childProcess = {
        execFile: function (executable, args, options, callback) {
            evidence.ffmpegExecutions++;
            const child = { pid: 1000 + evidence.ffmpegExecutions, kill: function () { } };
            evidence.childProcesses.push(child);
            callback(scenario.ffmpegOutcome === "error" ? new Error("injected ffmpeg failure") : null, "", "");
            return child;
        },
    };

    const context = {
        document: documentFake,
        csInterface: { evalScript: function (script, callback) { pickerCallbacks.push(callback); } },
        currentSection: "footage",
        showToast: function (message, kind) { evidence.toasts.push([message, kind]); },
        performance: { now: function () { return 0; } },
        console: { log: function () { }, warn: function () { }, error: function () { } },
        require: function (name) {
            if (name === "fs") return filesystem.fs;
            if (name === "path") return path;
            if (name === "child_process") return childProcess;
            throw new Error("Unexpected require: " + name);
        },
        setTimeout: function (handler, delay) { timerId++; timers[timerId] = { handler: handler, delay: delay }; return timerId; },
        clearTimeout: function (id) { delete timers[id]; },
        setInterval: function () { return 0; },
        clearInterval: function () { },
        Promise: SyncPromise,
        Image: mediaFakes.Image,
        localStorage: localStorageStub,
        commitVerifiedLocalStorage: function (key, stagingKey, prevKey, payload, verify) {
            // The ladder resolves its `localStorage` host from the persistence
            // module scope (not the vm realm), so pin this scenario's storage
            // host for the duration of the synchronous commit.
            const host = global.localStorage;
            global.localStorage = localStorageStub;
            try {
                return commitVerifiedLocalStorage(key, stagingKey, prevKey, payload, verify);
            } finally {
                if (host === undefined) delete global.localStorage;
                else global.localStorage = host;
            }
        },
        libraryIndexPayloadVerifies: libraryIndexPayloadVerifies,
        window: {
            rootPath: P14_LIBRARY_ROOT,
            allTemplates: [],
            Scheduler: scheduler,
            MediaEntryRepository: MediaEntryRepository,
            KeyedMediaCardHelper: KeyedMediaCardHelper,
            renderTemplateCardMarkup: p14RenderCardMarkup,
            PerfEvents: {
                mediaInstrumentationEnabled: true,
                createMediaScenarioMetrics: function () { return metrics; },
            },
            resolveFfmpeg: function (callback) {
                evidence.ffmpegResolutions++;
                callback(scenario.ffmpegAvailable ? "C:/tools/ffmpeg.exe" : "");
            },
            requestAnimationFrame: function (callback) { evidence.frames.push(callback); return evidence.frames.length; },
            cancelAnimationFrame: function () { },
            addEventListener: function () { },
            removeEventListener: function () { },
            URL: { createObjectURL: function () { return "blob:p14"; }, revokeObjectURL: function () { } },
        },
    };
    context.window.window = context.window;
    context.window.document = documentFake;
    vm.createContext(context);
    ENGINE_SCRIPT.runInContext(context);

    const engine = context.window;
    let thrown = null;
    try {
        engine.FastMedia.init();
        const button = buttons[scenario.pickerMode === "folder" ? "btn-import-folder" : "btn-import-file"];
        const clickHandlers = button.handlers.click || [];
        if (clickHandlers.length !== 1) throw new Error("Import button was not wired exactly once");
        clickHandlers[0]({ stopPropagation: function () { } });
        if (pickerCallbacks.length !== 1) throw new Error("Picker did not request exactly one host script");

        const selection = scenario.cancelled ? "" :
            (scenario.pickerMode === "folder" ? P14_SOURCE_FOLDER : P14_SOURCE_FOLDER + "/" + scenario.files[0].name);
        // The host returns native separators; the callback owns the normalization.
        pickerCallbacks[0](selection.replace(/\//g, "\\"));

        // Coalesced category/grid refreshes are part of the same completion path.
        for (let pass = 0; pass < 3 && evidence.frames.length; pass++) {
            const frames = evidence.frames.splice(0);
            for (let i = 0; i < frames.length; i++) frames[i]();
        }
    } catch (error) {
        thrown = error;
    } finally {
        try { engine.FastMedia.dispose(); } catch (ignoreDispose) { }
    }

    return { evidence: evidence, filesystem: filesystem, grid: grid, thrown: thrown, timers: timers, storage: storageData };
}

function p14Stages(evidence, stage) {
    return evidence.stageEnds.filter(function (entry) { return entry.stage === stage; });
}

function p14Check(scenario, run, tally) {
    const violations = [];
    const evidence = run.evidence;
    const expected = p14Expectations(scenario);

    if (run.thrown) violations.push("harness could not drive the pipeline: " + String(run.thrown && run.thrown.stack || run.thrown));

    // ── The property: no hot callback reaches a synchronous filesystem API ──
    if (evidence.pickerResults !== 1) {
        violations.push("picker completion callback did not run exactly once: " + evidence.pickerResults);
    }
    // Fix 4 contract: an accepted import must commit through the staged/verified
    // ladder — the media writer may never silently degrade to raw setItem.
    if (expected.expectsImport && !run.storage["compSaver_libraryIndex"]) {
        violations.push("production persist ladder never committed the media index");
    }
    if (run.filesystem.syncCalls.length !== 0) {
        violations.push("synchronous filesystem calls occurred: " + JSON.stringify(run.filesystem.syncCalls));
    }

    // ── Coverage: the callbacks the property claims to cover really ran ──
    if (expected.expectsImport) {
        if (!evidence.jobs.length) violations.push("no scheduler job was admitted for an accepted import");
        if (!p14Stages(evidence, "copy").length) violations.push("copy job completion callback never ran");
        if (expected.expectsThumbnail && !p14Stages(evidence, "thumbnail").length) {
            violations.push("thumbnail completion callback never ran after a successful copy");
        }
        if (expected.expectsFfmpeg && !p14Stages(evidence, "ffmpeg").length) {
            violations.push("FFmpeg completion callback never ran for a video needing fallback artwork");
        }
        if (!expected.expectsFfmpeg && p14Stages(evidence, "ffmpeg").length) {
            violations.push("FFmpeg ran without a fallback trigger");
        }
        if (evidence.cardPatches.length < expected.accepted.length) {
            violations.push("keyed card patch callback ran " + evidence.cardPatches.length +
                " times for " + expected.accepted.length + " accepted items");
        }
    } else {
        if (evidence.jobs.length) violations.push("work was admitted for a cancelled or empty picker result");
        if (evidence.stageEnds.length) violations.push("stage completion ran for a cancelled or empty picker result");
    }

    if (violations.length) {
        throw new Error("PROPERTY_14_COUNTEREXAMPLE " + JSON.stringify({
            scenario: scenario,
            expected: expected,
            violations: violations,
            syncCalls: run.filesystem.syncCalls,
            stageEnds: evidence.stageEnds,
            jobs: evidence.jobs,
            cardPatches: evidence.cardPatches,
        }, null, 2));
    }

    tally.runs++;
    tally.syncCalls += run.filesystem.syncCalls.length;
    if (scenario.cancelled) tally.cancellations++;
    if (!scenario.cancelled && !expected.expectsImport) tally.emptySelections++;
    if (expected.expectsCopyFailure) tally.copyFailures++;
    if (p14Stages(evidence, "thumbnail").length) tally.thumbnailCompletions++;
    if (p14Stages(evidence, "ffmpeg").length) tally.ffmpegCompletions++;
    if (evidence.ffmpegResolutions && !scenario.ffmpegAvailable) tally.ffmpegUnavailable++;
    if (evidence.ffmpegExecutions) tally.ffmpegExecutions++;
    if (evidence.cardPatches.indexOf(false) !== -1) tally.cardPatchFailures++;
    if (evidence.cardPatches.indexOf(true) !== -1) tally.cardPatchSuccesses++;
    return true;
}

const p14FileArbitrary = fc.record({
    name: fc.constantFrom("clip.mp4", "take one.mov", "reel.webm", "frame'1.jpg", "photo.png", "sheet.gif", "notes.txt"),
    size: fc.integer({ min: 0, max: 36 }),
});

const p14ScenarioArbitrary = fc.record({
    pickerMode: fc.constantFrom("file", "folder"),
    cancelled: fc.oneof({ arbitrary: fc.constant(false), weight: 6 }, { arbitrary: fc.constant(true), weight: 1 }),
    files: fc.array(p14FileArbitrary, { minLength: 1, maxLength: 3 }),
    copyOutcome: fc.constantFrom("success", "success", "success", "read-error", "write-error"),
    copyFailAtChunk: fc.nat({ max: 4 }),
    decodeOutcome: fc.constantFrom("success", "error"),
    canvasContext: fc.constantFrom("available", "available", "available", "missing"),
    ffmpegAvailable: fc.oneof({ arbitrary: fc.constant(true), weight: 3 }, { arbitrary: fc.constant(false), weight: 1 }),
    ffmpegOutcome: fc.constantFrom("success", "error"),
    proxyCached: fc.oneof({ arbitrary: fc.constant(false), weight: 3 }, { arbitrary: fc.constant(true), weight: 1 }),
    detachCardDuringThumbnail: fc.oneof({ arbitrary: fc.constant(false), weight: 3 }, { arbitrary: fc.constant(true), weight: 1 }),
});

describe("Media hot-callback synchronous filesystem exclusion", function () {
    test("Property 14: hot callbacks never use synchronous filesystem APIs", function () {
        const tally = {
            runs: 0, syncCalls: 0, cancellations: 0, emptySelections: 0, copyFailures: 0,
            thumbnailCompletions: 0, ffmpegCompletions: 0, ffmpegUnavailable: 0, ffmpegExecutions: 0,
            cardPatchFailures: 0, cardPatchSuccesses: 0,
        };
        /**
         * Feature: media-engine-lag, Property 14: Hot callbacks never use synchronous filesystem APIs
         * **Validates: Requirements 5.2**
         */
        fc.assert(fc.property(p14ScenarioArbitrary, function (scenario) {
            return p14Check(scenario, p14Run(scenario), tally);
        }), { seed: 140205, numRuns: 120 });

        // The property must not be vacuous: every covered callback really executed.
        expect(tally.runs).toBeGreaterThanOrEqual(120);
        expect(tally.syncCalls).toBe(0);
        expect(tally.cancellations).toBeGreaterThan(0);
        expect(tally.copyFailures).toBeGreaterThan(0);
        expect(tally.thumbnailCompletions).toBeGreaterThan(0);
        expect(tally.ffmpegCompletions).toBeGreaterThan(0);
        expect(tally.ffmpegUnavailable).toBeGreaterThan(0);
        expect(tally.ffmpegExecutions).toBeGreaterThan(0);
        expect(tally.cardPatchSuccesses).toBeGreaterThan(0);
        expect(tally.cardPatchFailures).toBeGreaterThan(0);
    }, 240000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scoped source guard: only the media hot-callback regions of
// js/core/fastMediaEngine.js are scanned for `fs.*Sync(` usage. Nothing outside
// those regions, and no other file, is in scope for Requirement 5.2 here.
// ─────────────────────────────────────────────────────────────────────────────

const P14_HOT_CALLBACK_REGIONS = [
    "function openMediaPicker(",
    "MediaImportCoordinator.prototype.importSelection = function",
    "MediaWorkCoordinator.prototype._stage = function",
    "MediaWorkCoordinator.prototype._afterStage = function",
    "MediaWorkCoordinator.prototype._complete = function",
    "MediaWorkCoordinator.prototype._completionFields = function",
    "MediaWorkCoordinator.prototype._cardFields = function",
    "function generateImageThumbnail(",
    "function extractVideoFrame(",
    "function generateFallbackThumbnail(",
    "function runFfmpegFallback(",
    "function executeFfmpeg(",
    "function runProductionHoverProxy(",
];

const P14_SYNC_FS_PATTERN = /\b(?:fs|fsImpl|nfs\(\)|require\((?:"fs"|'fs')\))\s*\.\s*[A-Za-z]+Sync\s*\(/g;

/**
 * Slice one top-level engine region by marker line and closing `    }` / `    };`,
 * matching the file's consistent single-IIFE indentation.
 */
function p14ExtractRegion(source, marker) {
    const lines = source.split(/\r?\n/);
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf(marker) !== -1) { start = i; break; }
    }
    if (start === -1) return null;
    for (let end = start + 1; end < lines.length; end++) {
        if (/^ {4}\};?$/.test(lines[end])) {
            return { marker: marker, startLine: start + 1, endLine: end + 1, text: lines.slice(start, end + 1).join("\n") };
        }
    }
    return null;
}

describe("Media hot-callback source guard", function () {
    test("no media hot-callback region calls a synchronous filesystem API", function () {
        const findings = [];
        const scanned = [];

        for (let i = 0; i < P14_HOT_CALLBACK_REGIONS.length; i++) {
            const region = p14ExtractRegion(ENGINE_SOURCE, P14_HOT_CALLBACK_REGIONS[i]);
            // A missing or trivial region would silently weaken the guard.
            expect(region).not.toBeNull();
            expect(region.text.length).toBeGreaterThan(60);
            scanned.push({ marker: region.marker, lines: region.endLine - region.startLine + 1 });

            P14_SYNC_FS_PATTERN.lastIndex = 0;
            let match;
            while ((match = P14_SYNC_FS_PATTERN.exec(region.text)) !== null) {
                findings.push({ region: region.marker, usage: match[0], startLine: region.startLine });
            }
        }

        expect(findings).toEqual([]);
        expect(scanned.length).toBe(P14_HOT_CALLBACK_REGIONS.length);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 15 harness — processing-stage lane ownership
//
// What is under test
// ------------------
// The REAL MediaWorkCoordinator and the REAL copy / thumbnail-decode / FFmpeg
// stage workers from js/core/fastMediaEngine.js, plus the REAL hover proxy plan
// from the production HoverPreviewController. Every scheduler entry point
// (`enqueue` and `defer`) is replaced by a recording scheduler that captures the
// lane name for each admitted stage AND keeps a lane stack while the stage
// worker runs, so each owned resource — copy streams, the destination mkdir and
// partial-output unlink, decode canvases/videos/images, the thumbnail PNG write,
// FFmpeg executable resolution, child processes and their handle release — is
// attributed to the lane that owned the work at the moment it happened.
//
// Promises inside the engine realm are the same deterministic synchronously
// settling implementation used by Property 14, so a whole copy → thumbnail →
// FFmpeg → hover-proxy plan resolves inside one synchronous predicate. Lane
// ownership is a routing fact, not a timing fact, so nothing about which lane
// owns which stage depends on that substitution.
// ─────────────────────────────────────────────────────────────────────────────

const P15_LIBRARY_ROOT = "C:/library";
const P15_SOURCE_FOLDER = "C:/originals";

// Requirement 5.3: copy work is owned by the filesystem lane, thumbnail/decode
// work by the thumbnail lane, FFmpeg thumbnail and proxy work by the FFmpeg lane.
const P15_LANE_BY_STAGE = {
    copy: "filesystem",
    thumbnail: "thumbnail",
    ffmpeg: "ffmpeg",
    "ffmpeg-proxy": "ffmpeg",
};
const P15_STAGES_BY_LANE = {
    filesystem: ["copy"],
    thumbnail: ["thumbnail"],
    ffmpeg: ["ffmpeg", "ffmpeg-proxy"],
};

const P15_VIDEO_EXTENSIONS = { ".mp4": true, ".mov": true, ".webm": true, ".avi": true };

function p15IsVideo(name) {
    const at = String(name).lastIndexOf(".");
    return at !== -1 && P15_VIDEO_EXTENSIONS[String(name).substring(at).toLowerCase()] === true;
}

/** Record the owning lane for every filesystem effect the stage workers cause. */
function p15WrapFilesystem(filesystem, pushResource) {
    const api = filesystem.fs;
    const createReadStream = api.createReadStream;
    const createWriteStream = api.createWriteStream;
    const promises = api.promises;
    const writeFile = promises.writeFile;
    const unlink = promises.unlink;
    const mkdir = promises.mkdir;
    const stat = promises.stat;

    api.createReadStream = function (target) {
        pushResource("copy-read-stream-open", "filesystem", target);
        const stream = createReadStream(target);
        const destroy = stream.destroy;
        stream.destroy = function () {
            if (!stream.destroyed) pushResource("copy-read-stream-close", "filesystem", target);
            return destroy.apply(stream, arguments);
        };
        return stream;
    };
    api.createWriteStream = function (target) {
        pushResource("copy-write-stream-open", "filesystem", target);
        const stream = createWriteStream(target);
        const end = stream.end;
        const destroy = stream.destroy;
        stream.end = function () {
            if (!stream.ended && !stream.destroyed) pushResource("copy-write-stream-close", "filesystem", target);
            return end.apply(stream, arguments);
        };
        stream.destroy = function () {
            if (!stream.destroyed && !stream.ended) pushResource("copy-write-stream-close", "filesystem", target);
            return destroy.apply(stream, arguments);
        };
        return stream;
    };
    promises.writeFile = function (target, data, encoding) {
        pushResource("thumbnail-write", "thumbnail", target);
        return writeFile(target, data, encoding);
    };
    promises.unlink = function (target) {
        pushResource("partial-output-unlink", "filesystem", target);
        return unlink(target);
    };
    promises.mkdir = function (target, options) {
        pushResource("destination-mkdir", "filesystem", target);
        return mkdir(target, options);
    };
    promises.stat = function (target) {
        pushResource("stat", "*", target);
        return stat(target);
    };
}

/**
 * Recording scheduler: captures the lane of every enqueue/defer and keeps the
 * owning lane on a stack for the duration of the stage worker.
 */
function p15CreateScheduler(SyncPromise, record) {
    function currentLane() {
        return record.laneStack.length ? record.laneStack[record.laneStack.length - 1] : null;
    }
    function pushResource(kind, expected, detail) {
        record.resourceOps.push({ kind: kind, expected: expected, lane: currentLane(), detail: detail || "" });
    }
    function control(lane) {
        return {
            isCancelled: function () { return false; },
            onCancel: function () { pushResource("cancel-hook", "*", lane); return false; },
            registerCleanup: function () { pushResource("cleanup-hook", "*", lane); },
            registerResource: function (resource) { pushResource("resource", "*", lane); return resource; },
            registerStream: function (stream) { pushResource("register-stream", "filesystem", lane); return stream; },
            registerVideo: function (video) { pushResource("register-video", "thumbnail", lane); return video; },
            registerObjectUrl: function (url) { pushResource("register-object-url", "thumbnail", lane); return url; },
            registerTimer: function (timer) { pushResource("register-timer", "*", lane); return timer; },
            registerChildProcess: function (child) { pushResource("register-child-process", "ffmpeg", lane); return child; },
            releaseProcess: function () { pushResource("release-process", "ffmpeg", lane); return true; },
        };
    }
    function admit(via, lane, worker, options, delay) {
        const entry = {
            via: via,
            lane: String(lane),
            stage: options && options.stage ? String(options.stage) : "",
            mediaId: options && options.mediaId ? String(options.mediaId) : "",
            sourcePath: options && options.sourcePath ? String(options.sourcePath) : "",
            owner: options && options.owner !== undefined ? String(options.owner) : "",
            delay: delay === undefined ? null : delay,
        };
        record.operations.push(entry);
        record.laneStack.push(entry.lane);
        let promise;
        try {
            promise = SyncPromise.resolve(worker(control(entry.lane)));
        } catch (error) {
            promise = SyncPromise.reject(error);
        }
        record.laneStack.pop();
        return { promise: promise, lane: entry.lane, cancel: function () { return false; } };
    }
    return {
        currentLane: currentLane,
        pushResource: pushResource,
        enqueue: function (lane, worker, options) { return admit("enqueue", lane, worker, options); },
        defer: function (lane, worker, delay, options) { return admit("defer", lane, worker, options, delay); },
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
}

/** Hover decoder double: each new source settles as configured, synchronously. */
function p15CreateHoverVideo(scenario) {
    const listeners = {};
    const video = {
        muted: false, loop: false, playsInline: false, autoplay: false, className: "",
        parentNode: null, duration: 8, error: null,
        addEventListener: function (name, listener) { (listeners[name] = listeners[name] || []).push(listener); },
        removeEventListener: function (name, listener) {
            const bucket = listeners[name] || [];
            const at = bucket.indexOf(listener);
            if (at !== -1) bucket.splice(at, 1);
        },
        setAttribute: function () { }, removeAttribute: function () { },
        pause: function () { }, load: function () { }, play: function () { return null; },
    };
    function dispatch(name) {
        const bucket = (listeners[name] || []).slice();
        for (let i = 0; i < bucket.length; i++) bucket[i]({ type: name });
    }
    Object.defineProperty(video, "src", {
        get: function () { return video._src || ""; },
        set: function (value) {
            video._src = value;
            if (!value) return;
            if (scenario.hoverOutcome === "error") {
                video.error = { code: 4 };
                dispatch("error");
                return;
            }
            video.error = null;
            dispatch("playing");
        },
    });
    return video;
}

/** Fire every pending fake timer whose delay matches, in creation order. */
function p15RunTimers(timers, delay) {
    const ids = Object.keys(timers).sort(function (a, b) { return Number(a) - Number(b); });
    for (let i = 0; i < ids.length; i++) {
        const entry = timers[ids[i]];
        if (!entry || entry.delay !== delay) continue;
        delete timers[ids[i]];
        entry.handler();
    }
}

/** The stage plan Requirement 5.3 must route, derived from the scenario alone. */
function p15Expected(scenario) {
    const planned = [];
    const copySucceeds = scenario.copyOutcome === "success";
    const decodeFails = scenario.decodeOutcome === "error" || scenario.canvasContext === "missing";
    for (let i = 0; i < scenario.items.length; i++) {
        const id = "media-" + (i + 1);
        const isVideo = p15IsVideo(scenario.items[i].name);
        planned.push({ lane: "filesystem", stage: "copy", mediaId: id });
        if (!copySucceeds) continue;
        planned.push({ lane: "thumbnail", stage: "thumbnail", mediaId: id });
        if (isVideo && decodeFails) planned.push({ lane: "ffmpeg", stage: "ffmpeg", mediaId: id });
    }
    if (scenario.hoverRequested && scenario.hoverOutcome === "error") {
        planned.push({ lane: "ffmpeg", stage: "ffmpeg-proxy", mediaId: "hover-media" });
    }
    return planned;
}

/**
 * Drive one batch of copy / thumbnail-decode / FFmpeg plans through the real
 * coordinator, then one hover proxy plan through the real hover controller.
 */
function p15Run(scenario) {
    const SyncPromise = p14CreateSyncPromise();
    const record = { operations: [], resourceOps: [], laneStack: [], commits: [], cardPatches: [], ffmpegExecutions: 0 };
    const scheduler = p15CreateScheduler(SyncPromise, record);
    const pushResource = scheduler.pushResource;

    const filesystem = p15CreateFilesystemForP15(SyncPromise, scenario, pushResource);
    const items = [];
    for (let i = 0; i < scenario.items.length; i++) {
        const spec = scenario.items[i];
        const id = "media-" + (i + 1);
        const safeName = "asset-" + (i + 1);
        const folder = P15_LIBRARY_ROOT + "/footage/" + safeName;
        const sourcePath = P15_SOURCE_FOLDER + "/" + spec.name;
        filesystem.addFile(sourcePath, spec.size);
        items.push({
            id: id,
            sourcePath: sourcePath,
            fileName: spec.name,
            safeName: safeName,
            isVideo: p15IsVideo(spec.name),
            destinationFolder: folder,
            destinationMedia: folder + "/" + spec.name,
            destinationThumbnail: folder + "/thumbnail.png",
        });
    }

    const evidence = { canvases: 0, videos: 0, images: 0 };
    const baseMedia = p14CreateMediaFakes(scenario, evidence, {
        onCanvas: function () { pushResource("decode-canvas", "thumbnail"); },
    });
    const mediaFakes = {
        createElement: function (tag) {
            const name = String(tag).toLowerCase();
            if (name === "video") pushResource("decode-video", "thumbnail");
            return baseMedia.createElement(name);
        },
        Image: function () {
            pushResource("decode-image", "thumbnail");
            return baseMedia.Image();
        },
    };

    const miniDocument = createMiniDocument();
    const documentFake = p14CreateDocument(miniDocument, {}, mediaFakes);
    const timers = {};
    let timerSeq = 0;

    const childProcess = {
        execFile: function (executable, args, options, callback) {
            record.ffmpegExecutions++;
            pushResource("ffmpeg-exec", "ffmpeg", executable);
            const child = { pid: 3000 + record.ffmpegExecutions, kill: function () { } };
            callback(scenario.ffmpegOutcome === "error" ? new Error("injected ffmpeg failure") : null, "", "");
            return child;
        },
    };

    const context = {
        document: documentFake,
        csInterface: { evalScript: function () { } },
        currentSection: "footage",
        showToast: function () { },
        performance: { now: function () { return 0; } },
        console: { log: function () { }, warn: function () { }, error: function () { } },
        require: function (name) {
            if (name === "fs") return filesystem.fs;
            if (name === "path") return path;
            if (name === "child_process") return childProcess;
            throw new Error("Unexpected require: " + name);
        },
        setTimeout: function (handler, delay) { timerSeq++; timers[timerSeq] = { handler: handler, delay: delay }; return timerSeq; },
        clearTimeout: function (id) { delete timers[id]; },
        setInterval: function () { return 0; },
        clearInterval: function () { },
        Promise: SyncPromise,
        Image: mediaFakes.Image,
        window: {
            rootPath: P15_LIBRARY_ROOT,
            allTemplates: [],
            Scheduler: scheduler,
            resolveFfmpeg: function (callback) {
                pushResource("ffmpeg-resolve", "ffmpeg");
                callback(scenario.ffmpegAvailable ? "C:/tools/ffmpeg.exe" : "");
            },
            requestAnimationFrame: null,
            addEventListener: function () { },
            removeEventListener: function () { },
            URL: { createObjectURL: function () { return "blob:p15"; }, revokeObjectURL: function () { } },
        },
    };
    context.window.window = context.window;
    context.window.document = documentFake;
    vm.createContext(context);
    ENGINE_SCRIPT.runInContext(context);

    const engine = context.window;
    let snapshot = null;
    let thrown = null;
    let coordinator = null;
    let hoverController = null;
    try {
        coordinator = new engine.MediaWorkCoordinator({
            scheduler: scheduler,
            repository: {
                patchById: function (id) {
                    record.commits.push({ id: id, lane: scheduler.currentLane() });
                    return SyncPromise.resolve({ ok: true });
                },
            },
            cards: {
                patchById: function (id) {
                    record.cardPatches.push({ id: id, lane: scheduler.currentLane() });
                    return true;
                },
            },
            progressIntervalMs: 100000,
        });
        coordinator.submitBatch({ id: "batch-p15", items: items }).then(function (result) { snapshot = result; });

        if (scenario.hoverRequested) {
            const hoverId = "hover-media";
            const hoverFolder = P15_LIBRARY_ROOT + "/footage/hover";
            const hoverOriginal = hoverFolder + "/original.mp4";
            filesystem.addFile(hoverOriginal, 24);
            const card = miniDocument.createElement("div");
            card.className = "card";
            card.id = "tpl-" + hoverId;
            card.setAttribute("data-media-id", hoverId);
            card.setAttribute("data-type", "media");
            card.setAttribute("data-mediatype", "video");
            card.setAttribute("data-folder", hoverFolder);
            card.setAttribute("data-originalpath", hoverOriginal);
            if (scenario.hoverHasProxy) card.setAttribute("data-proxypath", hoverFolder + "/proxy.mp4");
            const thumbBox = miniDocument.createElement("div");
            thumbBox.className = "thumb-box";
            card.appendChild(thumbBox);
            miniDocument.body.appendChild(card);

            const hoverVideo = p15CreateHoverVideo(scenario);
            hoverController = new engine.HoverPreviewController({
                document: documentFake,
                scheduler: scheduler,
                owner: "p15-hover",
                setTimeout: context.setTimeout,
                clearTimeout: context.clearTimeout,
                createVideo: function () { return hoverVideo; },
            });
            hoverController.request(card);
            p15RunTimers(timers, 150);
        }
    } catch (error) {
        thrown = error;
    } finally {
        try { if (hoverController) hoverController.dispose(); } catch (ignoreHoverDispose) { }
        try { if (coordinator) coordinator.dispose("property 15 complete"); } catch (ignoreDispose) { }
    }

    return { record: record, snapshot: snapshot, filesystem: filesystem, thrown: thrown, evidence: evidence };
}

/** p14's instrumented filesystem plus per-lane attribution of every effect. */
function p15CreateFilesystemForP15(SyncPromise, scenario, pushResource) {
    const filesystem = p14CreateFilesystem(SyncPromise, scenario);
    p15WrapFilesystem(filesystem, pushResource);
    filesystem.addDirectory(P15_LIBRARY_ROOT);
    filesystem.addDirectory(P15_SOURCE_FOLDER);
    return filesystem;
}

function p15Key(entry) {
    return entry.lane + "|" + entry.stage + "|" + entry.mediaId;
}

function p15Check(scenario, run, tally) {
    const violations = [];
    const operations = run.record.operations;
    const expected = p15Expected(scenario);

    if (run.thrown) {
        violations.push("harness could not drive the plans: " + String((run.thrown && run.thrown.stack) || run.thrown));
    }
    if (run.filesystem.syncCalls.length !== 0) {
        violations.push("stage work used synchronous filesystem calls: " + JSON.stringify(run.filesystem.syncCalls));
    }

    // ── The property: every scheduled stage is owned by exactly one lane ──
    const byStageAndId = {};
    for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        const owner = P15_LANE_BY_STAGE[op.stage];
        if (!op.stage) {
            violations.push("work was scheduled on lane " + op.lane + " without a processing stage");
            continue;
        }
        if (!owner) {
            violations.push("unknown processing stage " + op.stage + " was scheduled on lane " + op.lane);
            continue;
        }
        if (op.lane !== owner) {
            violations.push(op.stage + " work for " + op.mediaId + " was scheduled on lane " + op.lane +
                " instead of its owning lane " + owner);
        }
        if ((P15_STAGES_BY_LANE[op.lane] || []).indexOf(op.stage) === -1) {
            violations.push("lane " + op.lane + " owned foreign stage " + op.stage);
        }
        if (!op.mediaId) violations.push(op.stage + " work was scheduled without a Stable_Media_ID");
        if (!op.sourcePath) violations.push(op.stage + " work for " + op.mediaId + " was scheduled without a source path");
        if (!op.owner) violations.push(op.stage + " work for " + op.mediaId + " was scheduled without an owner");
        const key = op.stage + "|" + op.mediaId;
        (byStageAndId[key] = byStageAndId[key] || []).push(op.lane);
    }
    const stageKeys = Object.keys(byStageAndId);
    for (let k = 0; k < stageKeys.length; k++) {
        const lanes = byStageAndId[stageKeys[k]];
        const distinct = lanes.filter(function (lane, at) { return lanes.indexOf(lane) === at; });
        if (distinct.length !== 1) {
            violations.push(stageKeys[k] + " was owned by more than one lane: " + JSON.stringify(distinct));
        }
        if (lanes.length !== 1) {
            violations.push(stageKeys[k] + " was scheduled " + lanes.length + " times");
        }
    }

    // ── Owned effects happen while their owning lane holds the work ──
    for (let r = 0; r < run.record.resourceOps.length; r++) {
        const effect = run.record.resourceOps[r];
        if (!effect.lane) {
            violations.push(effect.kind + " ran without any owning lane (" + effect.detail + ")");
            continue;
        }
        if (effect.expected !== "*" && effect.lane !== effect.expected) {
            violations.push(effect.kind + " ran under lane " + effect.lane +
                " instead of its owning lane " + effect.expected + " (" + effect.detail + ")");
        }
    }

    // ── The routed plan matches the copy / thumbnail / FFmpeg / proxy plan ──
    const actualKeys = operations.map(p15Key).sort();
    const expectedKeys = expected.map(p15Key).sort();
    if (actualKeys.join(" ") !== expectedKeys.join(" ")) {
        violations.push("routed stages " + JSON.stringify(actualKeys) + " do not match planned stages " +
            JSON.stringify(expectedKeys));
    }

    if (violations.length) {
        throw new Error("PROPERTY_15_COUNTEREXAMPLE " + JSON.stringify({
            scenario: scenario,
            violations: violations,
            operations: operations,
            resourceOps: run.record.resourceOps,
        }, null, 2));
    }

    tally.runs++;
    for (let o = 0; o < operations.length; o++) {
        if (operations[o].stage === "copy") tally.copyStages++;
        if (operations[o].stage === "thumbnail") tally.thumbnailStages++;
        if (operations[o].stage === "ffmpeg") tally.ffmpegStages++;
        if (operations[o].stage === "ffmpeg-proxy") tally.proxyStages++;
    }
    tally.ffmpegExecutions += run.record.ffmpegExecutions;
    if (scenario.copyOutcome !== "success") tally.copyFailures++;
    for (let e = 0; e < run.record.resourceOps.length; e++) {
        const kind = run.record.resourceOps[e].kind;
        if (kind === "copy-read-stream-open" || kind === "copy-write-stream-open") tally.copyStreams++;
        if (kind === "decode-canvas" || kind === "decode-video" || kind === "decode-image") tally.decodeResources++;
        if (kind === "register-child-process") tally.childProcesses++;
        if (kind === "release-process") tally.processReleases++;
    }
    return true;
}

const p15ItemArbitrary = fc.record({
    name: fc.constantFrom("clip.mp4", "take one.mov", "reel.webm", "frame'1.jpg", "photo.png", "sheet.gif"),
    size: fc.integer({ min: 0, max: 32 }),
});

const p15ScenarioArbitrary = fc.record({
    items: fc.array(p15ItemArbitrary, { minLength: 1, maxLength: 3 }),
    copyOutcome: fc.constantFrom("success", "success", "success", "read-error", "write-error"),
    copyFailAtChunk: fc.nat({ max: 3 }),
    decodeOutcome: fc.constantFrom("success", "error"),
    canvasContext: fc.constantFrom("available", "available", "available", "missing"),
    ffmpegAvailable: fc.oneof({ arbitrary: fc.constant(true), weight: 3 }, { arbitrary: fc.constant(false), weight: 1 }),
    ffmpegOutcome: fc.constantFrom("success", "error"),
    proxyCached: fc.oneof({ arbitrary: fc.constant(false), weight: 3 }, { arbitrary: fc.constant(true), weight: 1 }),
    hoverRequested: fc.oneof({ arbitrary: fc.constant(true), weight: 3 }, { arbitrary: fc.constant(false), weight: 1 }),
    hoverHasProxy: fc.boolean(),
    hoverOutcome: fc.constantFrom("error", "error", "playing"),
});

describe("Media processing-stage lane ownership", function () {
    test("Property 15: every processing stage has one owning lane", function () {
        const tally = {
            runs: 0, copyStages: 0, thumbnailStages: 0, ffmpegStages: 0, proxyStages: 0,
            ffmpegExecutions: 0, copyFailures: 0, copyStreams: 0, decodeResources: 0,
            childProcesses: 0, processReleases: 0,
        };
        /**
         * Feature: media-engine-lag, Property 15: Every processing stage has one owning lane
         * **Validates: Requirements 5.3**
         */
        fc.assert(fc.property(p15ScenarioArbitrary, function (scenario) {
            return p15Check(scenario, p15Run(scenario), tally);
        }), { seed: 150307, numRuns: 120 });

        // The property must not be vacuous: all four plans really routed work.
        expect(tally.runs).toBeGreaterThanOrEqual(120);
        expect(tally.copyStages).toBeGreaterThan(0);
        expect(tally.thumbnailStages).toBeGreaterThan(0);
        expect(tally.ffmpegStages).toBeGreaterThan(0);
        expect(tally.proxyStages).toBeGreaterThan(0);
        expect(tally.copyFailures).toBeGreaterThan(0);
        expect(tally.copyStreams).toBeGreaterThan(0);
        expect(tally.decodeResources).toBeGreaterThan(0);
        expect(tally.ffmpegExecutions).toBeGreaterThan(0);
        expect(tally.childProcesses).toBeGreaterThan(0);
        expect(tally.processReleases).toBeGreaterThan(0);
    }, 240000);
});
