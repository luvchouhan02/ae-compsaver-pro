// ============================================================
// tests/media-hover-controller.test.js
//
// Feature: media-engine-lag
//
// EXAMPLE tests (no fast-check) for the hover-preview state machine and media
// disposal. Everything under test is the REAL code from js/core/fastMediaEngine.js:
// the actual HoverPreviewController driven through init() + dispatched pointer
// events, and the actual FastMedia.dispose() lifecycle. The only doubles are the
// environment the controller talks to: a fake clock (150 ms Hover_Intent and the
// 10-second activation timeout), a fake <video> decoder whose media callbacks are
// delivered by that clock, an FFmpeg-lane scheduler double, and the parsed
// mini-DOM from tests/helpers/miniDom.js.
//
// Covered scenarios
//   - Requirement 6.3       : pointer leaves before 150 ms -> no decode started.
//   - Requirement 6.5 / 6.9 : one proxy attempt, then exactly one original retry
//                             after a proxy load error, then one queued proxy job.
//   - Requirement 6.7       : stale-token callbacks are discarded with no state change.
//   - Requirement 6.6       : playback that has not begun within 10 s stops the
//                             decode attempt and leaves the static thumbnail visible.
//   - Requirement 8.7 / 8.3 : ten pointer transitions between two distinct video
//                             cards inside 5 s never exceed one active decoder.
//   - Requirement 8.7 / 8.10: zero active decoders after the final pointer leave
//                             and after FastMedia.dispose().
// ============================================================

"use strict";

const nodeFs = require("fs");
const path = require("path");
const vm = require("vm");
const miniDom = require("./helpers/miniDom");

const ROOT = path.resolve(__dirname, "..");
const ENGINE_SOURCE = nodeFs.readFileSync(path.join(ROOT, "js/core/fastMediaEngine.js"), "utf8");
const ENGINE_SCRIPT = new vm.Script(ENGINE_SOURCE, { filename: "fastMediaEngine.js" });

// Requirement 6.2 / 6.6 constants, restated so no assertion reads them from the
// implementation under test.
const HOVER_INTENT_MS = 150;
const HOVER_ACTIVATION_TIMEOUT_MS = 10000;

// ─────────────────────────────────────────────────────────────────────────────
// Engine realms. `createRealm()` loads the engine into a fresh vm context, which
// matters for the FastMedia.dispose() example: disposal latches module state, so
// that test must not share a realm with the hover examples.
// ─────────────────────────────────────────────────────────────────────────────
function createRealm() {
    const inertDocument = {
        getElementById: function () { return null; },
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        createElement: function () { throw new Error("the hover harness injects every element"); },
        addEventListener: function () { },
        removeEventListener: function () { },
    };
    const context = {
        window: {
            rootPath: "C:/library",
            allTemplates: [],
            addEventListener: function () { },
            removeEventListener: function () { },
            URL: { createObjectURL: function () { return ""; }, revokeObjectURL: function () { } },
        },
        document: inertDocument,
        performance: { now: function () { return 0; } },
        console: { log: function () { }, warn: function () { }, error: function () { } },
        require: function (name) {
            if (name === "path") return path;
            if (name === "fs") return { promises: {} };
            throw new Error("Unexpected require: " + name);
        },
        showToast: function () { },
        getLibraryIndex: function () { return null; },
        setTimeout: function () { throw new Error("hover work must use the injected clock"); },
        clearTimeout: function () { throw new Error("hover work must use the injected clock"); },
        setInterval: function () { return 0; },
        clearInterval: function () { },
        Promise: Promise,
        Date: Date,
        Buffer: Buffer,
        Image: function () { },
        btoa: function () { return ""; },
        unescape: function (value) { return value; },
        encodeURIComponent: encodeURIComponent,
    };
    context.window.window = context.window;
    context.window.document = inertDocument;
    vm.createContext(context);
    ENGINE_SCRIPT.runInContext(context);
    if (typeof context.window.HoverPreviewController !== "function") {
        throw new Error("HoverPreviewController was not exposed by the media engine");
    }
    return context.window;
}

let sharedRealm = null;
function getEngine() {
    if (!sharedRealm) sharedRealm = createRealm();
    return sharedRealm;
}

async function flushMicrotasks() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake clock: virtual time only, fired in (dueTime, creationOrder) order.
// ─────────────────────────────────────────────────────────────────────────────
function createClock() {
    const timers = {};
    let seq = 0;
    let now = 0;

    function earliest(target) {
        let best = null;
        const ids = Object.keys(timers);
        for (let i = 0; i < ids.length; i++) {
            const timer = timers[ids[i]];
            if (timer.at > target) continue;
            if (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id)) best = timer;
        }
        return best;
    }

    function register(tag, handler, delay) {
        seq++;
        const wait = Number(delay);
        timers[seq] = { id: seq, at: now + (wait >= 0 ? wait : 0), handler: handler, tag: tag };
        return seq;
    }

    return {
        now: function () { return now; },
        pendingCount: function (tag) {
            const ids = Object.keys(timers);
            let count = 0;
            for (let i = 0; i < ids.length; i++) if (!tag || timers[ids[i]].tag === tag) count++;
            return count;
        },
        setTimeout: function (handler, delay) { return register("controller", handler, delay); },
        mediaTimeout: function (handler, delay) { return register("media", handler, delay); },
        clearTimeout: function (id) { delete timers[id]; },
        advance: async function (ms) {
            const target = now + Math.max(0, Number(ms) || 0);
            let guard = 0;
            for (; ;) {
                const next = earliest(target);
                if (!next) break;
                if (++guard > 200) throw new Error("hover timers did not quiesce");
                delete timers[next.id];
                now = next.at;
                next.handler();
                await flushMicrotasks();
            }
            now = target;
            await flushMicrotasks();
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake decoder. "Owning a video decoder" is a non-empty source: the setter opens
// ownership, removeAttribute("src") / src = "" releases it. Every open, release,
// pause and media callback is logged with the controller's token at that instant.
// ─────────────────────────────────────────────────────────────────────────────
function createDecoderFactory(clock, log, ref, planFor) {
    const decoders = [];

    function tokenNow() {
        const controller = ref.controller;
        if (!controller || typeof controller.snapshot !== "function") return -1;
        return controller.snapshot().token;
    }

    function openCount() {
        let count = 0;
        for (let i = 0; i < decoders.length; i++) if (decoders[i].state.open) count++;
        return count;
    }

    function attachedCount() {
        let count = 0;
        for (let i = 0; i < decoders.length; i++) if (decoders[i].video.parentNode) count++;
        return count;
    }

    function create() {
        const listeners = {};
        const removedListeners = [];
        const state = { open: false, generation: 0, current: null, attempts: [] };
        const video = {
            nodeType: 1,
            parentNode: null,
            childNodes: [],
            className: "",
            muted: false,
            loop: false,
            playsInline: false,
            autoplay: false,
            error: null,
            _src: "",
        };
        const record = { state: state, video: video, listeners: listeners, removedListeners: removedListeners };
        decoders.push(record);

        function dispatch(name) {
            const bucket = (listeners[name] || []).slice();
            for (let i = 0; i < bucket.length; i++) bucket[i]({ type: name, target: video });
        }

        function isStale(attempt) {
            return attempt.generation !== state.generation || video._src !== attempt.url;
        }

        function settle(attempt, stale) {
            if (!attempt.settle || attempt.settled) return;
            attempt.settled = true;
            if (attempt.plan.outcome === "error") {
                attempt.settle.reject({ code: 4, name: "NotSupportedError", message: "media source not supported" });
            } else {
                attempt.settle.resolve();
            }
            log.push({ op: stale ? "stale-play-settled" : "play-settled", at: clock.now(), token: tokenNow() });
        }

        function scheduleOutcome(attempt) {
            if (attempt.plan.outcome === "never") return;
            clock.mediaTimeout(function () {
                const stale = isStale(attempt);
                log.push({
                    op: stale ? "stale-media-callback" : "media-callback",
                    at: clock.now(), token: tokenNow(), url: attempt.url, outcome: attempt.plan.outcome,
                });
                if (attempt.plan.delivery === "promise") {
                    if (!stale && attempt.plan.outcome === "error") video.error = { code: 4 };
                    settle(attempt, stale);
                    return;
                }
                if (stale) return;
                if (attempt.plan.outcome === "error") {
                    video.error = { code: 4 };
                    dispatch("error");
                } else {
                    dispatch("playing");
                }
            }, attempt.plan.latency);
        }

        function releaseSource() {
            if (!state.open) { video._src = ""; return; }
            state.open = false;
            const released = video._src;
            video._src = "";
            log.push({ op: "source-released", at: clock.now(), token: tokenNow(), url: released });
        }

        video.addEventListener = function (name, listener) {
            (listeners[name] = listeners[name] || []).push(listener);
        };
        video.removeEventListener = function (name, listener) {
            const bucket = listeners[name] || [];
            const at = bucket.indexOf(listener);
            if (at !== -1) {
                bucket.splice(at, 1);
                removedListeners.push({ name: name, listener: listener, token: tokenNow() });
            }
        };
        video.setAttribute = function () { };
        video.removeAttribute = function (name) {
            if (String(name).toLowerCase() === "src") releaseSource();
        };
        video.pause = function () {
            log.push({ op: "pause", at: clock.now(), token: tokenNow(), open: state.open });
        };
        video.load = function () {
            log.push({ op: "load", at: clock.now(), token: tokenNow(), open: state.open, url: video._src });
        };
        video.play = function () {
            const attempt = state.current;
            log.push({ op: "play", at: clock.now(), token: tokenNow(), url: video._src });
            if (!attempt || attempt.plan.delivery !== "promise") return null;
            return new Promise(function (resolve, reject) {
                attempt.settle = { resolve: resolve, reject: reject };
            });
        };
        Object.defineProperty(video, "src", {
            get: function () { return video._src; },
            set: function (value) {
                const url = value === undefined || value === null ? "" : String(value);
                if (!url) { releaseSource(); return; }
                const alreadyOwned = state.open;
                state.generation++;
                state.open = true;
                video._src = url;
                video.error = null;
                const attempt = {
                    url: url,
                    generation: state.generation,
                    plan: planFor(url),
                    settle: null,
                    settled: false,
                };
                state.current = attempt;
                state.attempts.push(attempt);
                log.push({
                    op: "source-opened", at: clock.now(), token: tokenNow(), url: url,
                    concurrentDecoders: openCount(), replacedOwnedSource: alreadyOwned,
                });
                scheduleOutcome(attempt);
            },
        });
        return video;
    }

    return {
        create: create,
        decoders: decoders,
        openCount: openCount,
        attachedCount: attachedCount,
        /** Replay every listener the controller detached while its token was stale. */
        replayStaleListeners: function (finalToken) {
            let replayed = 0;
            for (let i = 0; i < decoders.length; i++) {
                const entries = decoders[i].removedListeners;
                for (let j = 0; j < entries.length; j++) {
                    if (entries[j].token >= finalToken) continue;
                    replayed++;
                    entries[j].listener({ type: entries[j].name, target: decoders[i].video });
                }
            }
            return replayed;
        },
        /** Settle every play() promise that no longer belongs to the current source. */
        settleStalePromises: function () {
            let settled = 0;
            for (let i = 0; i < decoders.length; i++) {
                const record = decoders[i];
                const attempts = record.state.attempts;
                for (let j = 0; j < attempts.length; j++) {
                    const attempt = attempts[j];
                    if (attempt.settled || !attempt.settle) continue;
                    if (attempt.generation === record.state.generation && record.video._src === attempt.url) continue;
                    attempt.settled = true;
                    attempt.settle.resolve();
                    settled++;
                }
            }
            return settled;
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel document: real parsed mini-DOM cards plus a dispatcher for the pointer
// events the controller subscribes to in init().
// ─────────────────────────────────────────────────────────────────────────────
function cardSpec(index) {
    const id = "media-" + (index + 1);
    const folder = "C:/library/footage/asset-" + (index + 1);
    const original = folder + "/original-" + (index + 1) + ".mp4";
    const proxy = folder + "/proxy-" + (index + 1) + ".mp4";
    return {
        id: id,
        folder: folder,
        original: original,
        url: "file:///" + encodeURI(original),
        proxy: proxy,
        proxyUrl: "file:///" + encodeURI(proxy),
    };
}

function buildPanel(count) {
    const document = miniDom.createMiniDocument();
    const grid = document.createElement("div");
    grid.className = "card-grid";
    document.body.appendChild(grid);

    const cards = [];
    for (let i = 0; i < count; i++) {
        const spec = cardSpec(i);
        const card = document.createElement("div");
        card.className = "card";
        card.id = "tpl-" + spec.id;
        card.setAttribute("data-media-id", spec.id);
        card.setAttribute("data-type", "media");
        card.setAttribute("data-mediatype", "video");
        card.setAttribute("data-folder", spec.folder);
        card.setAttribute("data-originalpath", spec.original);
        card.setAttribute("data-file", "asset-" + (i + 1) + ".mp4");

        const thumbBox = document.createElement("div");
        thumbBox.className = "thumb-box";
        const thumb = document.createElement("img");
        thumb.className = "thumb-img";
        thumb.setAttribute("src", spec.folder + "/thumbnail.png");
        thumbBox.appendChild(thumb);
        card.appendChild(thumbBox);
        grid.appendChild(card);

        cards.push({ spec: spec, element: card, thumbBox: thumbBox, thumb: thumb });
    }

    const handlers = {};
    const documentFake = {
        createElement: function (tag) { return document.createElement(tag); },
        createDocumentFragment: function () { return document.createDocumentFragment(); },
        getElementById: function (id) { return document.getElementById(id); },
        querySelector: function (selector) { return document.querySelector(selector); },
        querySelectorAll: function (selector) { return document.querySelectorAll(selector); },
        addEventListener: function (name, listener) { (handlers[name] = handlers[name] || []).push(listener); },
        removeEventListener: function (name, listener) {
            const bucket = handlers[name] || [];
            const at = bucket.indexOf(listener);
            if (at !== -1) bucket.splice(at, 1);
        },
        dispatch: function (name, event) {
            const bucket = (handlers[name] || []).slice();
            for (let i = 0; i < bucket.length; i++) bucket[i](event);
            return bucket.length;
        },
    };
    Object.defineProperty(documentFake, "documentElement", { get: function () { return document.documentElement; } });
    Object.defineProperty(documentFake, "body", { get: function () { return document.body; } });

    return { document: documentFake, mini: document, cards: cards };
}

/** FFmpeg lane double: records the proxy requests the controller admits. */
function createSchedulerStub(proxyRequests) {
    function admit(lane, worker, options) {
        proxyRequests.push({
            lane: String(lane),
            stage: options && options.stage ? String(options.stage) : "",
            mediaId: options && options.mediaId ? String(options.mediaId) : "",
            sourcePath: options && options.sourcePath ? String(options.sourcePath) : "",
        });
        return {
            promise: Promise.resolve({ ok: false, status: "derivative-unavailable" }),
            lane: lane,
            cancel: function () { return false; },
        };
    }
    return {
        enqueue: function (lane, worker, options) { return admit(lane, worker, options); },
        defer: function (lane, worker, delay, options) { return admit(lane, worker, options); },
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

// ─────────────────────────────────────────────────────────────────────────────
// Harness: the real controller plus the fakes above, exposed through the pointer
// gestures and observations the examples need.
// ─────────────────────────────────────────────────────────────────────────────
function createHarness(options) {
    options = options || {};
    const engine = options.engine || getEngine();
    const cardCount = options.cardCount || 2;
    const panel = buildPanel(cardCount);
    const specs = [];
    for (let i = 0; i < cardCount; i++) specs.push(panel.cards[i].spec);
    if (options.proxyCards) {
        for (let i = 0; i < options.proxyCards.length; i++) {
            const index = options.proxyCards[i];
            panel.cards[index].element.setAttribute("data-proxypath", specs[index].proxy);
        }
    }

    const plans = options.plans || {};
    const clock = createClock();
    const log = [];
    const ref = { controller: null };
    const factory = createDecoderFactory(clock, log, ref, function (url) {
        return plans[url] || { outcome: "never", latency: 0, delivery: "event" };
    });
    const proxyRequests = [];
    const decoderObservations = [];
    const controller = new engine.HoverPreviewController({
        document: panel.document,
        scheduler: createSchedulerStub(proxyRequests),
        owner: options.owner || "example-hover",
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        createVideo: factory.create,
        metrics: { observeDecoderCount: function (count) { decoderObservations.push(count); } },
    });
    ref.controller = controller;
    controller.init();

    const harness = {
        controller: controller,
        clock: clock,
        factory: factory,
        panel: panel,
        specs: specs,
        log: log,
        proxyRequests: proxyRequests,
        decoderObservations: decoderObservations,
        enter: async function (index) {
            panel.document.dispatch("mouseover", { target: panel.cards[index].thumbBox, relatedTarget: null });
            await flushMicrotasks();
        },
        leave: async function (index) {
            panel.document.dispatch("mouseout", { target: panel.cards[index].thumbBox, relatedTarget: null });
            await flushMicrotasks();
        },
        advance: async function (ms) { await clock.advance(ms); },
        opens: function (from) {
            const urls = [];
            for (let i = from || 0; i < log.length; i++) if (log[i].op === "source-opened") urls.push(log[i].url);
            return urls;
        },
        entries: function (op) {
            const found = [];
            for (let i = 0; i < log.length; i++) if (log[i].op === op) found.push(log[i]);
            return found;
        },
        thumbnailsVisible: function () {
            for (let i = 0; i < panel.cards.length; i++) {
                if (!panel.cards[i].thumbBox.querySelector(".thumb-img")) return false;
            }
            return true;
        },
    };
    return harness;
}

const PLAYS_FAST = { outcome: "playing", latency: 20, delivery: "event" };
const NEVER_STARTS = { outcome: "never", latency: 0, delivery: "event" };

describe("HoverPreviewController examples", function () {
    test("pointer leaving before the 150 ms intent completes starts no decode work (Requirement 6.3)", async function () {
        const harness = createHarness({
            plans: (function () {
                const plans = {};
                plans[cardSpec(0).url] = PLAYS_FAST;
                return plans;
            })(),
        });

        await harness.enter(0);
        await harness.advance(HOVER_INTENT_MS - 1);

        const midIntent = harness.controller.snapshot();
        expect(midIntent.phase).toBe("intent");
        expect(midIntent.intentTimerCount).toBe(1);
        expect(midIntent.activeDecoderCount).toBe(0);
        expect(harness.factory.openCount()).toBe(0);
        expect(harness.opens()).toEqual([]);

        await harness.leave(0);
        // Long past both the intent delay and any media latency: cancellation must be permanent.
        await harness.advance(5000);

        const after = harness.controller.snapshot();
        expect(after.phase).toBe("idle");
        expect(after.cardId).toBe("");
        expect(after.intentTimerCount).toBe(0);
        expect(after.activationTimerCount).toBe(0);
        expect(after.activeDecoderCount).toBe(0);
        expect(after.attachedVideoCount).toBe(0);
        expect(harness.opens()).toEqual([]);
        expect(harness.factory.decoders.length).toBe(0);
        expect(harness.clock.pendingCount("controller")).toBe(0);
        expect(harness.thumbnailsVisible()).toBe(true);
    });

    test("a proxy load error falls back to the original exactly once and queues one proxy job (Requirements 6.5, 6.9, 6.10)", async function () {
        const spec = cardSpec(0);
        const plans = {};
        plans[spec.proxyUrl] = { outcome: "error", latency: 30, delivery: "event" };
        plans[spec.url] = { outcome: "error", latency: 30, delivery: "event" };
        const harness = createHarness({ proxyCards: [0], plans: plans });

        await harness.enter(0);
        await harness.advance(HOVER_INTENT_MS);
        await harness.advance(1000);

        // Requirement 6.5: the proxy is chosen first; Requirement 6.9: one original retry.
        expect(harness.opens()).toEqual([spec.proxyUrl, spec.url]);
        expect(harness.controller.snapshot().phase).toBe("idle");
        expect(harness.factory.openCount()).toBe(0);

        // Requirement 6.9: the failed original queued exactly one FFmpeg-lane proxy job.
        expect(harness.proxyRequests.length).toBe(1);
        expect(harness.proxyRequests[0].lane).toBe("ffmpeg");
        expect(harness.proxyRequests[0].stage).toBe("ffmpeg-proxy");
        expect(harness.proxyRequests[0].mediaId).toBe(spec.id);

        // Hovering the same card again must not retry the proven-unplayable proxy
        // and must not queue a second job for the same Stable_Media_ID.
        const mark = harness.log.length;
        await harness.enter(0);
        await harness.advance(HOVER_INTENT_MS);
        await harness.advance(1000);

        expect(harness.opens(mark)).toEqual([spec.url]); // Requirement 6.5: no second proxy attempt
        expect(harness.proxyRequests.length).toBe(1); // Requirement 6.10
        expect(harness.controller.snapshot().proxyRequestCount).toBe(1);
        expect(harness.thumbnailsVisible()).toBe(true);
    });

    test("stale-token callbacks are discarded and change no state (Requirement 6.7)", async function () {
        const specA = cardSpec(0);
        const specB = cardSpec(1);
        const plans = {};
        // Latencies outlive the hover, so both callbacks land after the stop.
        plans[specA.url] = { outcome: "playing", latency: 4000, delivery: "promise" };
        plans[specB.url] = { outcome: "playing", latency: 4000, delivery: "event" };
        const harness = createHarness({ plans: plans });

        // Card A: decode starts, play() promise still pending when the pointer leaves.
        await harness.enter(0);
        await harness.advance(HOVER_INTENT_MS);
        expect(harness.controller.snapshot().phase).toBe("loading");
        await harness.leave(0);

        // Card B: decode starts and its "playing" listener is detached by the stop.
        await harness.enter(1);
        await harness.advance(HOVER_INTENT_MS);
        await harness.leave(1);

        const before = harness.controller.snapshot();
        expect(before.phase).toBe("idle");
        expect(before.activeDecoderCount).toBe(0);

        // Deliver the now-stale media callbacks: the timer-backed outcome, the
        // pending play() promise, and the detached event listeners.
        await harness.advance(6000);
        const staleSettled = harness.factory.settleStalePromises();
        await flushMicrotasks();
        const staleReplayed = harness.factory.replayStaleListeners(before.token);
        await flushMicrotasks();

        expect(harness.entries("stale-media-callback").length + harness.entries("stale-play-settled").length)
            .toBeGreaterThan(0);
        expect(staleSettled + staleReplayed).toBeGreaterThan(0);

        const after = harness.controller.snapshot();
        expect(after).toEqual(before);
        expect(harness.factory.openCount()).toBe(0);
        expect(harness.factory.attachedCount()).toBe(0);
        expect(harness.clock.pendingCount("controller")).toBe(0);
        expect(harness.thumbnailsVisible()).toBe(true);
    });

    test("playback that has not begun within 10 seconds stops the decode and leaves the thumbnail visible (Requirement 6.6)", async function () {
        const spec = cardSpec(0);
        const plans = {};
        plans[spec.url] = NEVER_STARTS;
        const harness = createHarness({ plans: plans });

        await harness.enter(0);
        await harness.advance(HOVER_INTENT_MS);

        const loading = harness.controller.snapshot();
        expect(loading.phase).toBe("loading");
        expect(loading.activationTimerCount).toBe(1);
        expect(loading.activeDecoderCount).toBe(1);
        expect(harness.factory.openCount()).toBe(1);

        // One millisecond short of the timeout: still trying.
        await harness.advance(HOVER_ACTIVATION_TIMEOUT_MS - 1);
        expect(harness.controller.snapshot().phase).toBe("loading");
        expect(harness.factory.openCount()).toBe(1);

        await harness.advance(1);

        const stopped = harness.controller.snapshot();
        expect(stopped.phase).toBe("idle");
        expect(stopped.token).toBe(loading.token + 1); // Requirement 6.8: token first
        expect(stopped.activeDecoderCount).toBe(0);
        expect(stopped.attachedVideoCount).toBe(0);
        expect(stopped.activationTimerCount).toBe(0);
        expect(harness.factory.openCount()).toBe(0);
        expect(harness.factory.attachedCount()).toBe(0);
        expect(harness.clock.pendingCount("controller")).toBe(0);

        const releases = harness.entries("source-released");
        expect(releases.length).toBe(1);
        expect(releases[0].at).toBe(HOVER_INTENT_MS + HOVER_ACTIVATION_TIMEOUT_MS);

        // The static thumbnail was never removed by hover work.
        expect(harness.thumbnailsVisible()).toBe(true);
        expect(harness.panel.cards[0].thumbBox.querySelector(".thumb-img").getAttribute("src"))
            .toBe(spec.folder + "/thumbnail.png");
    });

    test("ten pointer transitions between two video cards within 5 seconds never exceed one active decoder (Requirements 8.3, 8.7)", async function () {
        const specA = cardSpec(0);
        const specB = cardSpec(1);
        const plans = {};
        plans[specA.url] = PLAYS_FAST;
        plans[specB.url] = PLAYS_FAST;
        const harness = createHarness({ plans: plans });

        let peakOpen = 0;
        let peakReported = 0;
        function sample() {
            const snapshot = harness.controller.snapshot();
            peakOpen = Math.max(peakOpen, harness.factory.openCount());
            peakReported = Math.max(peakReported, snapshot.activeDecoderCount);
            expect(harness.factory.openCount()).toBeLessThanOrEqual(1);
            expect(snapshot.activeDecoderCount).toBeLessThanOrEqual(1);
            expect(snapshot.attachedVideoCount).toBeLessThanOrEqual(1);
        }

        // 10 transitions: the pointer moves straight from one card to the other,
        // each hover lasting long enough (300 ms) to complete intent and play.
        for (let i = 0; i < 10; i++) {
            await harness.enter(i % 2);
            sample();
            await harness.advance(HOVER_INTENT_MS);
            sample();
            await harness.advance(150);
            sample();
        }
        // 10 x 300 ms of virtual time = 3000 ms, inside the 5-second window.
        expect(harness.clock.now()).toBeLessThan(5000);

        // Ten decode attempts, each starting only after the previous release.
        const opens = harness.entries("source-opened");
        expect(opens.length).toBe(10);
        for (let i = 0; i < opens.length; i++) {
            expect(opens[i].replacedOwnedSource).toBe(false);
            expect(opens[i].concurrentDecoders).toBe(1);
        }
        expect(harness.entries("source-released").length).toBe(9);
        expect(peakOpen).toBe(1);
        expect(peakReported).toBe(1);
        for (let i = 0; i < harness.decoderObservations.length; i++) {
            expect(harness.decoderObservations[i]).toBeLessThanOrEqual(1);
        }

        // Requirement 8.7: zero active decoders after the final pointer leave.
        await harness.leave(9 % 2);
        await harness.advance(1000);

        const final = harness.controller.snapshot();
        expect(final.phase).toBe("idle");
        expect(final.activeDecoderCount).toBe(0);
        expect(final.attachedVideoCount).toBe(0);
        expect(final.listenerCount).toBe(0);
        expect(harness.factory.openCount()).toBe(0);
        expect(harness.factory.attachedCount()).toBe(0);
        expect(harness.entries("source-released").length).toBe(10);
        expect(harness.clock.pendingCount("controller")).toBe(0);
        expect(harness.thumbnailsVisible()).toBe(true);
        // One reusable video resource served all ten transitions.
        expect(harness.factory.decoders.length).toBe(1);
    });

    test("FastMedia.dispose during playback leaves zero active decoders and no hover resources (Requirements 8.7, 8.10)", async function () {
        // A dedicated realm: disposal latches the engine's module state.
        const engine = createRealm();
        const spec = cardSpec(0);
        const panel = buildPanel(1);
        const clock = createClock();
        const log = [];
        const ref = { controller: null };
        const plans = {};
        plans[spec.url] = PLAYS_FAST;
        const factory = createDecoderFactory(clock, log, ref, function (url) {
            return plans[url] || NEVER_STARTS;
        });
        const proxyRequests = [];
        const controller = engine.FastMedia.createHoverPreviewController({
            document: panel.document,
            scheduler: createSchedulerStub(proxyRequests),
            owner: "example-dispose",
            setTimeout: clock.setTimeout,
            clearTimeout: clock.clearTimeout,
            createVideo: factory.create,
        });
        ref.controller = controller;
        controller.init();

        panel.document.dispatch("mouseover", { target: panel.cards[0].thumbBox, relatedTarget: null });
        await flushMicrotasks();
        await clock.advance(HOVER_INTENT_MS);
        await clock.advance(50);

        const playing = controller.snapshot();
        expect(playing.phase).toBe("playing");
        expect(playing.activeDecoderCount).toBe(1);
        expect(factory.openCount()).toBe(1);

        expect(engine.FastMedia.dispose()).toBe(true);

        const disposed = controller.snapshot();
        expect(disposed.disposed).toBe(true);
        expect(disposed.token).toBe(playing.token + 1); // Requirement 6.8
        expect(disposed.phase).toBe("idle");
        expect(disposed.activeDecoderCount).toBe(0);
        expect(disposed.attachedVideoCount).toBe(0);
        expect(disposed.ownsVideo).toBe(false);
        expect(disposed.listenerCount).toBe(0);
        expect(disposed.documentListenerCount).toBe(0);
        expect(factory.openCount()).toBe(0);
        expect(factory.attachedCount()).toBe(0);
        expect(clock.pendingCount("controller")).toBe(0);

        // Pointer events after disposal must not resurrect a decoder.
        panel.document.dispatch("mouseover", { target: panel.cards[0].thumbBox, relatedTarget: null });
        await flushMicrotasks();
        await clock.advance(HOVER_INTENT_MS + 1000);
        expect(factory.openCount()).toBe(0);
        expect(controller.snapshot().activeDecoderCount).toBe(0);

        // Disposal is idempotent and the static thumbnail survived.
        expect(engine.FastMedia.dispose()).toBe(false);
        expect(panel.cards[0].thumbBox.querySelector(".thumb-img")).toBeTruthy();
    });
});
