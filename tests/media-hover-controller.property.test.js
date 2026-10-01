// ============================================================
// tests/media-hover-controller.property.test.js
//
// Feature: media-engine-lag
//
// What is under test
// ------------------
// The REAL HoverPreviewController from js/core/fastMediaEngine.js, driven only
// through its public surface: `init()` plus dispatched pointer events on a fake
// panel document, a fake clock for the 150 ms Hover_Intent timer and the
// 10-second activation timeout, and a fake <video> whose media callbacks
// ("playing" / "error" events and play() promise settlements) are delivered by
// that same clock. Nothing about the state machine is re-implemented inside the
// controller's realm: the engine source is loaded once into a vm context and
// every dependency (document, scheduler, timers, decoder) is injected.
//
// The reference model in this file is an independent transcription of
// Requirement 6's acceptance criteria (intent at 150 ms, one decoder, token
// increments before every release, 10-second non-start returns to the static
// thumbnail). The property compares the real controller against that model
// after every step, so a divergence in either direction is a counterexample.
// ============================================================

"use strict";

const nodeFs = require("fs");
const path = require("path");
const vm = require("vm");
const fc = require("fast-check");
const miniDom = require("./helpers/miniDom");

const ROOT = path.resolve(__dirname, "..");
const ENGINE_SOURCE = nodeFs.readFileSync(path.join(ROOT, "js/core/fastMediaEngine.js"), "utf8");
const ENGINE_SCRIPT = new vm.Script(ENGINE_SOURCE, { filename: "fastMediaEngine.js" });

// Requirement 6.2 / 6.6 constants, restated here so the model never reads them
// from the implementation under test.
const HOVER_INTENT_MS = 150;
const HOVER_ACTIVATION_TIMEOUT_MS = 10000;
const CARD_COUNT = 3;

// ─────────────────────────────────────────────────────────────────────────────
// The engine realm. Loaded once: HoverPreviewController receives its document,
// scheduler, clock and decoder per run through constructor options, so a shared
// realm never shares hover state between runs.
// ─────────────────────────────────────────────────────────────────────────────
let cachedEngine = null;

function getEngine() {
    if (cachedEngine) return cachedEngine;
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
    cachedEngine = context.window;
    return cachedEngine;
}

async function flushMicrotasks() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake clock: virtual time only, fired in (dueTime, creationOrder) order so the
// interleaving of the intent timer, the activation timeout and media callbacks
// is deterministic.
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
        /** Pending timers owned by the controller (tag "controller") or by the media fake. */
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
// Fake decoder. "Owning a video decoder" is modelled as holding a non-empty
// source: the source setter opens ownership, removeAttribute("src") / src = ""
// release it. Every open, release, pause, load and media callback is logged with
// the controller's token at that instant, which is what makes Requirement 6.8's
// ordering (token increments BEFORE pause/release) observable.
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
    return { id: id, folder: folder, original: original, url: "file:///" + encodeURI(original) };
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

/** FFmpeg lane double: proxy requests are Property 21's subject, so nothing runs. */
function createSchedulerStub(proxyRequests) {
    function admit(lane, worker, options) {
        proxyRequests.push({
            lane: String(lane),
            stage: options && options.stage ? String(options.stage) : "",
            mediaId: options && options.mediaId ? String(options.mediaId) : "",
        });
        return { promise: Promise.resolve({ ok: false, status: "derivative-unavailable" }), lane: lane, cancel: function () { return false; } };
    }
    return {
        enqueue: function (lane, worker, options) { return admit(lane, worker, options); },
        defer: function (lane, worker, delay, options) { return admit(lane, worker, options); },
        cancelByOwner: function () { return true; },
        snapshot: function () {
            return { lanes: { filesystem: { pending: 0, active: 0 }, thumbnail: { pending: 0, active: 0 }, ffmpeg: { pending: 0, active: 0 } }, processes: 0 };
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference model: Requirement 6's acceptance criteria transcribed as an
// event-driven state machine. Times are virtual and advance with the same deltas
// the fake clock receives, so model and controller stay in lockstep.
// ─────────────────────────────────────────────────────────────────────────────
function createModel(specs, plans) {
    const model = {
        now: 0,
        token: 0,
        phase: "idle",
        cardIndex: -1,
        intentAt: null,
        activationAt: null,
        mediaAt: null,
        mediaCard: -1,
        attempts: [],
        episodes: [],
        stops: [],
    };

    function closeEpisode(reason) {
        for (let i = model.episodes.length - 1; i >= 0; i--) {
            if (model.episodes[i].endedAt === null) {
                model.episodes[i].endedAt = model.now;
                model.episodes[i].endReason = reason;
                break;
            }
        }
    }

    // Requirement 6.8: every stop increments the token before any release work.
    function stop(reason) {
        model.token++;
        model.stops.push({ at: model.now, reason: reason, token: model.token });
        closeEpisode(reason);
        model.phase = "idle";
        model.cardIndex = -1;
        model.intentAt = null;
        model.activationAt = null;
        model.mediaAt = null;
        model.mediaCard = -1;
    }

    model.enter = function (index) {
        // Re-entering the card that is already hovering changes nothing.
        if (model.phase !== "idle" && model.cardIndex === index) return;
        stop("superseded");
        model.cardIndex = index;
        model.phase = "intent";
        model.intentAt = model.now + HOVER_INTENT_MS; // Requirement 6.2
        model.episodes.push({
            cardIndex: index, start: model.now, started: false, startedAt: null,
            endedAt: null, endReason: null, attemptIndex: -1,
        });
    };

    model.leave = function (index) {
        if (model.cardIndex !== index) return; // pointer left a card that was not previewing
        stop("pointer-leave"); // Requirement 6.3 / 6.8
    };

    model.advance = function (ms) {
        const target = model.now + Math.max(0, Number(ms) || 0);
        for (; ;) {
            let when = null;
            let which = null;
            if (model.intentAt !== null && model.intentAt <= target) { when = model.intentAt; which = "intent"; }
            if (model.activationAt !== null && model.activationAt <= target && (when === null || model.activationAt < when)) {
                when = model.activationAt; which = "activation";
            }
            if (model.mediaAt !== null && model.mediaAt <= target && (when === null || model.mediaAt < when)) {
                when = model.mediaAt; which = "media";
            }
            if (which === null) break;
            model.now = when;

            if (which === "intent") {
                // Requirement 6.2: intent completed, decode work starts now.
                model.intentAt = null;
                const index = model.cardIndex;
                const plan = plans[index];
                model.activationAt = model.now + HOVER_ACTIVATION_TIMEOUT_MS; // Requirement 6.6
                model.phase = "loading";
                model.mediaCard = index;
                model.mediaAt = plan.outcome === "never" ? null : model.now + plan.latency;
                const attemptIndex = model.attempts.length;
                model.attempts.push({ at: model.now, cardIndex: index, url: specs[index].url });
                for (let e = model.episodes.length - 1; e >= 0; e--) {
                    if (model.episodes[e].endedAt === null) {
                        model.episodes[e].started = true;
                        model.episodes[e].startedAt = model.now;
                        // Attribute the decode attempt to this hover episode by ordinal, not by
                        // timestamp: a stop and the next enter can share the same virtual instant.
                        model.episodes[e].attemptIndex = attemptIndex;
                        break;
                    }
                }
            } else if (which === "activation") {
                model.activationAt = null;
                stop("activation-timeout"); // Requirement 6.6
            } else {
                model.mediaAt = null;
                const plan = plans[model.mediaCard];
                if (plan.outcome === "playing") {
                    model.phase = "playing";
                    model.activationAt = null;
                } else {
                    stop("media-error"); // Requirement 6.8
                }
            }
        }
        model.now = target;
    };

    return model;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-step comparison: the controller snapshot against the acceptance model.
// ─────────────────────────────────────────────────────────────────────────────
function compareState(label, context) {
    const model = context.model;
    const snapshot = context.controller.snapshot();
    const factory = context.factory;
    const violations = context.violations;
    const expectedCardId = model.cardIndex === -1 ? "" : context.specs[model.cardIndex].id;
    const expectedIntentTimers = model.intentAt === null ? 0 : 1;
    const expectedActivationTimers = model.activationAt === null ? 0 : 1;

    if (snapshot.phase !== model.phase) {
        violations.push(label + ": phase is \"" + snapshot.phase + "\" but Requirement 6 expects \"" + model.phase + "\"");
    }
    // Requirement 6.4 / 6.8: the token is the state machine's only identity.
    if (snapshot.token !== model.token) {
        violations.push(label + ": cancellation token is " + snapshot.token + " but Requirement 6 expects " + model.token);
    }
    if (snapshot.cardId !== expectedCardId) {
        violations.push(label + ": current card is \"" + snapshot.cardId + "\" but expected \"" + expectedCardId + "\"");
    }
    // Requirement 6.1: never more than one owned decoder.
    if (snapshot.activeDecoderCount > 1) {
        violations.push(label + ": controller reports " + snapshot.activeDecoderCount + " owned decoders");
    }
    if (factory.openCount() > 1) {
        violations.push(label + ": " + factory.openCount() + " video sources are owned at once");
    }
    if (snapshot.intentTimerCount !== expectedIntentTimers) {
        violations.push(label + ": intent timers " + snapshot.intentTimerCount + " but expected " + expectedIntentTimers);
    }
    if (snapshot.activationTimerCount !== expectedActivationTimers) {
        violations.push(label + ": activation timers " + snapshot.activationTimerCount + " but expected " + expectedActivationTimers);
    }
    if (context.clock.pendingCount("controller") !== expectedIntentTimers + expectedActivationTimers) {
        violations.push(label + ": " + context.clock.pendingCount("controller") + " hover timers are still armed but expected " +
            (expectedIntentTimers + expectedActivationTimers));
    }
    if (snapshot.documentListenerCount !== context.baseDocumentListeners) {
        violations.push(label + ": document listeners " + snapshot.documentListenerCount + " but expected " + context.baseDocumentListeners);
    }

    if (model.phase === "idle") {
        // Requirement 6.3 / 6.6 / 6.8: nothing owned, static thumbnail left in place.
        if (snapshot.activeDecoderCount !== 0 || factory.openCount() !== 0) {
            violations.push(label + ": idle state still owns a decoder (" + snapshot.activeDecoderCount + "/" + factory.openCount() + ")");
        }
        if (snapshot.listenerCount !== 0) {
            violations.push(label + ": idle state kept " + snapshot.listenerCount + " media listeners");
        }
        if (snapshot.attachedVideoCount !== 0 || factory.attachedCount() !== 0) {
            violations.push(label + ": idle state left a video attached to the DOM");
        }
    } else if (model.phase === "intent") {
        // Requirement 6.3: no decode work before the 150 ms intent completes.
        if (snapshot.activeDecoderCount !== 0 || factory.openCount() !== 0) {
            violations.push(label + ": decode work started before the 150 ms intent completed");
        }
    } else if (model.phase === "loading" || model.phase === "playing") {
        if (snapshot.activeDecoderCount !== 1 || factory.openCount() !== 1) {
            violations.push(label + ": " + model.phase + " state owns " + factory.openCount() + " decoders instead of exactly one");
        }
        if (snapshot.attachedVideoCount !== 1) {
            violations.push(label + ": " + model.phase + " state has " + snapshot.attachedVideoCount + " attached videos instead of one");
        }
    }

    // The static thumbnail must never be removed by hover work.
    for (let i = 0; i < context.panel.cards.length; i++) {
        if (!context.panel.cards[i].thumbBox.querySelector(".thumb-img")) {
            violations.push(label + ": static thumbnail of " + context.specs[i].id + " was removed");
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Log-based checks: ordering facts a snapshot cannot express.
// ─────────────────────────────────────────────────────────────────────────────
function checkLog(context) {
    const violations = context.violations;
    const log = context.log;
    const model = context.model;
    const opens = [];
    const releases = [];

    let openToken = -1;
    let openIndex = -1;
    for (let i = 0; i < log.length; i++) {
        const entry = log[i];
        if (entry.op === "source-opened") {
            // Requirement 6.1 / 6.4: a replacement starts only after the previous release.
            if (entry.replacedOwnedSource) {
                violations.push("a new decode attempt at " + entry.at + "ms replaced a source that was still owned");
            }
            if (entry.concurrentDecoders !== 1) {
                violations.push("decode attempt at " + entry.at + "ms ran with " + entry.concurrentDecoders + " owned decoders");
            }
            if (openIndex !== -1 && !releases.some(function (release) { return release.index > openIndex; })) {
                violations.push("decode attempt at " + entry.at + "ms began before the previous decoder was released");
            }
            openToken = entry.token;
            openIndex = i;
            opens.push({ at: entry.at, url: entry.url, token: entry.token, index: i });
        } else if (entry.op === "source-released") {
            // Requirement 6.8: the token increments before the source is released.
            if (openToken !== -1 && entry.token <= openToken) {
                violations.push("source released at " + entry.at + "ms with token " + entry.token +
                    " which did not increment past the attempt token " + openToken);
            }
            releases.push({ at: entry.at, token: entry.token, index: i });
        } else if (entry.op === "pause" && entry.open) {
            // Requirement 6.8: playback is paused only after the token increment.
            if (openToken !== -1 && entry.token <= openToken) {
                violations.push("playback paused at " + entry.at + "ms with token " + entry.token +
                    " which did not increment past the attempt token " + openToken);
            }
        }
    }

    // Requirement 6.2 / 6.3: attempts happen exactly where the model says.
    const actualAttempts = opens.map(function (open) { return { at: open.at, url: open.url }; });
    const expectedAttempts = model.attempts.map(function (attempt) { return { at: attempt.at, url: attempt.url }; });
    if (JSON.stringify(actualAttempts) !== JSON.stringify(expectedAttempts)) {
        violations.push("decode attempts " + JSON.stringify(actualAttempts) + " do not match the expected attempts " +
            JSON.stringify(expectedAttempts));
    }

    // Every logged decode attempt belongs to exactly one hover episode, matched by
    // ordinal: `opens` and `model.attempts` were already proven equal above.
    const attributed = {};
    for (let e = 0; e < model.episodes.length; e++) {
        const episode = model.episodes[e];
        const endedAt = episode.endedAt === null ? model.now : episode.endedAt;
        if (episode.started) {
            // Requirement 6.2: 150 ms of continuous hover completes intent and starts decode.
            if (episode.startedAt !== episode.start + HOVER_INTENT_MS) {
                violations.push("hover starting at " + episode.start + "ms started decode at " + episode.startedAt + "ms");
            }
            const open = opens[episode.attemptIndex];
            attributed[episode.attemptIndex] = true;
            if (!open || open.at !== episode.start + HOVER_INTENT_MS || open.url !== context.specs[episode.cardIndex].url) {
                violations.push("hover starting at " + episode.start + "ms did not open " + context.specs[episode.cardIndex].id +
                    " at 150 ms (got " + JSON.stringify(open || null) + ")");
            }
        } else {
            // Requirement 6.3: leaving before 150 ms cancels without decode work.
            if (endedAt - episode.start >= HOVER_INTENT_MS) {
                violations.push("hover starting at " + episode.start + "ms lasted " + (endedAt - episode.start) +
                    "ms without starting decode work");
            }
            if (episode.attemptIndex !== -1) {
                violations.push("hover cancelled after " + (endedAt - episode.start) + "ms still started decode work");
            }
        }
    }
    // No decoder may be opened outside a hover episode that completed its intent.
    for (let o = 0; o < opens.length; o++) {
        if (!attributed[o]) {
            violations.push("decode attempt at " + opens[o].at + "ms belongs to no completed hover intent");
        }
    }

    // Requirement 6.6: a 10-second non-start stops the attempt and releases the decoder.
    for (let s = 0; s < model.stops.length; s++) {
        const stop = model.stops[s];
        if (stop.reason !== "activation-timeout") continue;
        if (!releases.some(function (release) { return release.at === stop.at; })) {
            violations.push("playback that had not begun within 10 s at " + stop.at + "ms did not release its decoder");
        }
    }
}

async function runScenario(scenario) {
    const engine = getEngine();
    const specs = [];
    for (let i = 0; i < CARD_COUNT; i++) specs.push(cardSpec(i));
    const plans = scenario.cards;
    const planByUrl = {};
    for (let i = 0; i < CARD_COUNT; i++) planByUrl[specs[i].url] = plans[i];

    const clock = createClock();
    const log = [];
    const ref = { controller: null };
    const factory = createDecoderFactory(clock, log, ref, function (url) {
        return planByUrl[url] || { outcome: "never", latency: 0, delivery: "event" };
    });
    const panel = buildPanel(CARD_COUNT);
    const proxyRequests = [];
    const decoderObservations = [];
    const controller = new engine.HoverPreviewController({
        document: panel.document,
        scheduler: createSchedulerStub(proxyRequests),
        owner: "property-20-hover",
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        createVideo: factory.create,
        metrics: { observeDecoderCount: function (count) { decoderObservations.push(count); } },
    });
    ref.controller = controller;
    controller.init();

    const model = createModel(specs, plans);
    const violations = [];
    const context = {
        model: model, controller: controller, factory: factory, clock: clock, panel: panel,
        specs: specs, violations: violations, log: log,
        baseDocumentListeners: controller.snapshot().documentListenerCount,
    };
    compareState("after init", context);

    for (let s = 0; s < scenario.steps.length; s++) {
        const step = scenario.steps[s];
        const label = "step " + (s + 1) + " (" + step.type + (step.type === "advance" ? " " + step.ms + "ms" : " card " + (step.card + 1)) + ")";
        if (step.type === "enter") {
            model.enter(step.card);
            panel.document.dispatch("mouseover", { target: panel.cards[step.card].thumbBox, relatedTarget: null });
            await flushMicrotasks();
        } else if (step.type === "leave") {
            model.leave(step.card);
            panel.document.dispatch("mouseout", { target: panel.cards[step.card].thumbBox, relatedTarget: null });
            await flushMicrotasks();
        } else {
            model.advance(step.ms);
            await clock.advance(step.ms);
        }
        compareState(label, context);
    }

    // Requirement 6.7: replaying stale-token callbacks must change nothing.
    const beforeStale = JSON.stringify(controller.snapshot());
    const staleSettled = factory.settleStalePromises();
    await flushMicrotasks();
    const staleReplayed = factory.replayStaleListeners(controller.snapshot().token);
    await flushMicrotasks();
    const afterStale = JSON.stringify(controller.snapshot());
    if (beforeStale !== afterStale) {
        violations.push("stale-token callbacks changed the controller state: " + beforeStale + " -> " + afterStale);
    }
    compareState("after stale callbacks", context);

    // Requirement 6.8: disposal is a stop, so it increments the token first.
    const tokenBeforeDispose = controller.snapshot().token;
    controller.dispose();
    const disposed = controller.snapshot();
    if (disposed.token !== tokenBeforeDispose + 1) {
        violations.push("disposal moved the token from " + tokenBeforeDispose + " to " + disposed.token);
    }
    if (!disposed.disposed) violations.push("disposal did not mark the controller disposed");
    if (disposed.activeDecoderCount !== 0 || factory.openCount() !== 0) {
        violations.push("disposal left " + factory.openCount() + " owned decoders");
    }
    if (disposed.listenerCount !== 0 || disposed.documentListenerCount !== 0) {
        violations.push("disposal left listeners: media " + disposed.listenerCount + ", document " + disposed.documentListenerCount);
    }
    if (disposed.attachedVideoCount !== 0 || factory.attachedCount() !== 0) {
        violations.push("disposal left a video attached to the DOM");
    }
    if (clock.pendingCount("controller") !== 0) {
        violations.push("disposal left " + clock.pendingCount("controller") + " hover timers armed");
    }

    checkLog(context);

    // Requirement 6.1: the reported decoder count is only ever 0 or 1.
    for (let d = 0; d < decoderObservations.length; d++) {
        if (decoderObservations[d] !== 0 && decoderObservations[d] !== 1) {
            violations.push("decoder count observation " + decoderObservations[d] + " exceeds one decoder");
        }
    }

    let timeoutStops = 0;
    let playingReached = 0;
    for (let s = 0; s < model.stops.length; s++) if (model.stops[s].reason === "activation-timeout") timeoutStops++;
    for (let l = 0; l < log.length; l++) if (log[l].op === "media-callback" && log[l].outcome === "playing") playingReached++;

    return {
        violations: violations,
        staleSettled: staleSettled,
        staleReplayed: staleReplayed,
        attempts: model.attempts.length,
        timeoutStops: timeoutStops,
        playingReached: playingReached,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Generators. Latencies straddle the 150 ms intent and the 10-second activation
// timeout (10000 itself is excluded so timer ties stay unambiguous), and both
// media delivery channels — "playing"/"error" events and play() promise
// settlements — are exercised.
// ─────────────────────────────────────────────────────────────────────────────
const decoderPlanArb = fc.record({
    outcome: fc.constantFrom("playing", "error", "never"),
    latency: fc.constantFrom(0, 1, 40, 150, 900, 9999, 12000),
    delivery: fc.constantFrom("event", "promise"),
});

const cardIndexArb = fc.integer({ min: 0, max: CARD_COUNT - 1 });

const stepArb = fc.oneof(
    { arbitrary: fc.record({ type: fc.constant("enter"), card: cardIndexArb }), weight: 3 },
    { arbitrary: fc.record({ type: fc.constant("leave"), card: cardIndexArb }), weight: 2 },
    {
        arbitrary: fc.record({
            type: fc.constant("advance"),
            ms: fc.constantFrom(1, 20, 149, 150, 151, 300, 1000, 9999, 10000, 10001, 13000),
        }),
        weight: 4,
    }
);

const scenarioArb = fc.record({
    cards: fc.tuple(decoderPlanArb, decoderPlanArb, decoderPlanArb),
    steps: fc.array(stepArb, { minLength: 3, maxLength: 14 }),
});

// Guard against a vacuous pass: the generated scenarios must really reach decode
// work, a 10-second non-start, and stale-token callbacks.
const coverage = { runs: 0, attempts: 0, timeoutStops: 0, staleReplays: 0, stalePromises: 0, playingReached: 0 };

describe("Property 20: Hover preview is a single-token state machine", function () {
    afterAll(function () {
        expect(coverage.runs).toBeGreaterThanOrEqual(100);
        expect(coverage.attempts).toBeGreaterThan(0);
        expect(coverage.playingReached).toBeGreaterThan(0);
        expect(coverage.timeoutStops).toBeGreaterThan(0);
        expect(coverage.staleReplays).toBeGreaterThan(0);
    });
    test("pointer sequences, media callbacks, replacements, timeouts and disposal keep one token and one decoder", async function () {
        // Feature: media-engine-lag, Property 20: Hover preview is a single-token state machine
        // **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.6, 6.7, 6.8**
        await fc.assert(
            fc.asyncProperty(scenarioArb, async function (scenario) {
                const result = await runScenario(scenario);
                coverage.runs++;
                coverage.attempts += result.attempts;
                coverage.timeoutStops += result.timeoutStops;
                coverage.staleReplays += result.staleReplayed;
                coverage.stalePromises += result.staleSettled;
                coverage.playingReached += result.playingReached;
                if (result.violations.length !== 0) {
                    throw new Error("PROPERTY_20_COUNTEREXAMPLE " + JSON.stringify({
                        cards: scenario.cards,
                        steps: scenario.steps,
                        violations: result.violations,
                    }, null, 2));
                }
            }),
            { numRuns: 120 }
        );
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Property 21 harness. Same realm, same fake clock, same decoder factory and
// same panel builder as Property 20; only the source-selection facts change, so
// the cards additionally carry a `data-proxypath` and the FFmpeg-lane double's
// recording of proxy requests becomes the observable under test.
//
// Requirement 6.5  : a proxy that loads without a media-loading error is the
//                    source chosen for hover playback.
// Requirement 6.9  : an original that cannot begin playback with no playable
//                    proxy and no queued/active proxy request for the same
//                    Stable_Media_ID queues exactly one FFmpeg-lane request.
// Requirement 6.10 : while that request is queued or active, the FFmpeg lane
//                    never holds a second request for the same Stable_Media_ID.
// ═════════════════════════════════════════════════════════════════════════════

/** Long enough for every generated media latency to be delivered, well inside the 10 s activation timeout. */
const HOVER_SETTLE_MS = 2000;

function proxySpec(index) {
    const spec = cardSpec(index);
    const proxyPath = spec.folder + "/proxy-" + (index + 1) + ".mp4";
    return { proxyPath: proxyPath, proxyUrl: "file:///" + encodeURI(proxyPath) };
}

async function runProxyScenario(scenario) {
    const engine = getEngine();
    const specs = [];
    const proxies = [];
    for (let i = 0; i < CARD_COUNT; i++) {
        specs.push(cardSpec(i));
        proxies.push(proxySpec(i));
    }
    const plans = scenario.cards;
    const planByUrl = {};
    for (let i = 0; i < CARD_COUNT; i++) {
        planByUrl[specs[i].url] = plans[i].original;
        planByUrl[proxies[i].proxyUrl] = plans[i].proxy;
    }

    const clock = createClock();
    const log = [];
    const ref = { controller: null };
    const factory = createDecoderFactory(clock, log, ref, function (url) {
        return planByUrl[url] || { outcome: "never", latency: 0, delivery: "event" };
    });
    const panel = buildPanel(CARD_COUNT);
    for (let i = 0; i < CARD_COUNT; i++) {
        if (plans[i].hasProxy) panel.cards[i].element.setAttribute("data-proxypath", proxies[i].proxyPath);
    }

    const proxyRequests = [];
    const controller = new engine.HoverPreviewController({
        document: panel.document,
        scheduler: createSchedulerStub(proxyRequests),
        owner: "property-21-hover",
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        createVideo: factory.create,
    });
    ref.controller = controller;
    controller.init();

    const violations = [];
    // Independent transcription of the controller's persistent per-card state:
    // a proxy proven unplayable is never chosen again, and a Stable_Media_ID with
    // a queued or active proxy request never gets a second one.
    const unplayableProxy = [];
    const proxyQueued = [];
    const stats = { proxyChosen: 0, proxyPlayed: 0, proxyFallbacks: 0, originalFirst: 0, queuedRequests: 0, suppressedRequests: 0 };

    function requestsFor(mediaId) {
        let count = 0;
        for (let i = 0; i < proxyRequests.length; i++) if (proxyRequests[i].mediaId === mediaId) count++;
        return count;
    }

    function opensSince(mark) {
        const urls = [];
        for (let i = mark; i < log.length; i++) if (log[i].op === "source-opened") urls.push(log[i].url);
        return urls;
    }

    async function hoverRound(index, label) {
        const plan = plans[index];
        const spec = specs[index];
        const logMark = log.length;
        const requestMark = proxyRequests.length;

        // Expected behaviour, derived from Requirement 6.5 / 6.9 / 6.10 only.
        const expectedOpens = [];
        let expectedNewRequests = 0;
        let expectedPhase = "idle";
        let triesOriginal = true;
        const proxyIsCandidate = plan.hasProxy && !unplayableProxy[index];
        if (proxyIsCandidate) {
            stats.proxyChosen++;
            expectedOpens.push(proxies[index].proxyUrl); // Requirement 6.5
            if (plan.proxy.outcome === "playing") {
                expectedPhase = "playing";
                triesOriginal = false;
                stats.proxyPlayed++;
            } else {
                unplayableProxy[index] = true;
                stats.proxyFallbacks++;
            }
        } else {
            stats.originalFirst++;
        }
        if (triesOriginal) {
            expectedOpens.push(spec.url); // one original attempt, never more
            if (plan.original.outcome === "playing") {
                expectedPhase = "playing";
            } else if (proxyQueued[index]) {
                stats.suppressedRequests++; // Requirement 6.10
            } else {
                expectedNewRequests = 1; // Requirement 6.9
                proxyQueued[index] = true;
                stats.queuedRequests++;
            }
        }

        panel.document.dispatch("mouseover", { target: panel.cards[index].thumbBox, relatedTarget: null });
        await flushMicrotasks();
        await clock.advance(HOVER_INTENT_MS);
        await clock.advance(HOVER_SETTLE_MS);

        const actualOpens = opensSince(logMark);
        const snapshot = controller.snapshot();
        if (JSON.stringify(actualOpens) !== JSON.stringify(expectedOpens)) {
            violations.push(label + ": hover opened " + JSON.stringify(actualOpens) +
                " but Requirement 6.5/6.9 expects " + JSON.stringify(expectedOpens));
        }
        if (snapshot.phase !== expectedPhase) {
            violations.push(label + ": phase is \"" + snapshot.phase + "\" but expected \"" + expectedPhase + "\"");
        }
        if (expectedPhase === "playing" && snapshot.activeDecoderCount !== 1) {
            violations.push(label + ": playback reported " + snapshot.activeDecoderCount + " decoders instead of one");
        }

        const newRequests = proxyRequests.slice(requestMark);
        if (newRequests.length !== expectedNewRequests) {
            violations.push(label + ": queued " + newRequests.length + " proxy requests but Requirement 6.9/6.10 expects " +
                expectedNewRequests + " (" + JSON.stringify(newRequests) + ")");
        }
        for (let n = 0; n < newRequests.length; n++) {
            // Requirement 6.9: the request goes through the FFmpeg lane for this Stable_Media_ID.
            if (newRequests[n].lane !== "ffmpeg") {
                violations.push(label + ": proxy request used lane \"" + newRequests[n].lane + "\" instead of the FFmpeg lane");
            }
            if (newRequests[n].stage !== "ffmpeg-proxy") {
                violations.push(label + ": proxy request stage is \"" + newRequests[n].stage + "\" instead of \"ffmpeg-proxy\"");
            }
            if (newRequests[n].mediaId !== spec.id) {
                violations.push(label + ": proxy request carries media id \"" + newRequests[n].mediaId + "\" instead of \"" + spec.id + "\"");
            }
        }
        // Requirement 6.10: at most one request per Stable_Media_ID, ever.
        const total = requestsFor(spec.id);
        if (total !== (proxyQueued[index] ? 1 : 0)) {
            violations.push(label + ": the FFmpeg lane holds " + total + " proxy requests for " + spec.id +
                " but expected " + (proxyQueued[index] ? 1 : 0));
        }

        panel.document.dispatch("mouseout", { target: panel.cards[index].thumbBox, relatedTarget: null });
        await flushMicrotasks();
        const afterLeave = controller.snapshot();
        if (afterLeave.phase !== "idle" || factory.openCount() !== 0) {
            violations.push(label + ": after pointer leave the phase is \"" + afterLeave.phase + "\" with " +
                factory.openCount() + " owned sources");
        }
    }

    for (let r = 0; r < scenario.rounds.length; r++) {
        await hoverRound(scenario.rounds[r].card, "round " + (r + 1) + " (card " + (scenario.rounds[r].card + 1) + ")");
    }

    // Requirement 6.10, driven deterministically: every card whose original already
    // queued a proxy request is hovered twice more, and each of those hovers fails
    // the same way. No second request may appear for that Stable_Media_ID.
    for (let i = 0; i < CARD_COUNT; i++) {
        if (!proxyQueued[i]) continue;
        for (let repeat = 0; repeat < 2; repeat++) {
            const mark = proxyRequests.length;
            await hoverRound(i, "repeat hover " + (repeat + 1) + " (card " + (i + 1) + ")");
            if (proxyRequests.length !== mark) {
                violations.push("repeat hover " + (repeat + 1) + " on card " + (i + 1) +
                    " queued another proxy request while one was already queued or active");
            }
        }
    }

    let distinctQueued = 0;
    for (let i = 0; i < CARD_COUNT; i++) if (proxyQueued[i]) distinctQueued++;
    const finalSnapshot = controller.snapshot();
    if (finalSnapshot.proxyRequestCount !== distinctQueued) {
        violations.push("the controller tracks " + finalSnapshot.proxyRequestCount + " proxy requests but expected " + distinctQueued);
    }
    if (proxyRequests.length !== distinctQueued) {
        violations.push("the FFmpeg lane received " + proxyRequests.length + " proxy requests but expected " + distinctQueued);
    }

    controller.dispose();
    if (clock.pendingCount("controller") !== 0) {
        violations.push("disposal left " + clock.pendingCount("controller") + " hover timers armed");
    }

    return { violations: violations, stats: stats };
}

const proxyOutcomeArb = fc.record({
    outcome: fc.constantFrom("playing", "error"),
    latency: fc.constantFrom(0, 1, 40, 200),
    delivery: fc.constantFrom("event", "promise"),
});

const proxyCardArb = fc.record({
    hasProxy: fc.boolean(),
    proxy: proxyOutcomeArb,
    original: proxyOutcomeArb,
});

const proxyScenarioArb = fc.record({
    cards: fc.tuple(proxyCardArb, proxyCardArb, proxyCardArb),
    rounds: fc.array(fc.record({ card: cardIndexArb }), { minLength: 2, maxLength: 6 }),
});

// Guard against a vacuous pass: the generated scenarios must really select a
// proxy, fall back to an original after a proxy load error, queue a proxy
// request, and suppress at least one duplicate request.
const proxyCoverage = { runs: 0, proxyChosen: 0, proxyPlayed: 0, proxyFallbacks: 0, originalFirst: 0, queuedRequests: 0, suppressedRequests: 0 };

describe("Property 21: Hover proxy selection and generation are deduplicated", function () {
    afterAll(function () {
        expect(proxyCoverage.runs).toBeGreaterThanOrEqual(100);
        expect(proxyCoverage.proxyPlayed).toBeGreaterThan(0);
        expect(proxyCoverage.proxyFallbacks).toBeGreaterThan(0);
        expect(proxyCoverage.originalFirst).toBeGreaterThan(0);
        expect(proxyCoverage.queuedRequests).toBeGreaterThan(0);
        expect(proxyCoverage.suppressedRequests).toBeGreaterThan(0);
    });
    test("a loadable proxy is preferred, a failed proxy falls back to the original once, and each media id queues at most one proxy job", async function () {
        // Feature: media-engine-lag, Property 21: Hover proxy selection and generation are deduplicated
        // **Validates: Requirements 6.5, 6.9, 6.10**
        await fc.assert(
            fc.asyncProperty(proxyScenarioArb, async function (scenario) {
                const result = await runProxyScenario(scenario);
                proxyCoverage.runs++;
                proxyCoverage.proxyChosen += result.stats.proxyChosen;
                proxyCoverage.proxyPlayed += result.stats.proxyPlayed;
                proxyCoverage.proxyFallbacks += result.stats.proxyFallbacks;
                proxyCoverage.originalFirst += result.stats.originalFirst;
                proxyCoverage.queuedRequests += result.stats.queuedRequests;
                proxyCoverage.suppressedRequests += result.stats.suppressedRequests;
                if (result.violations.length !== 0) {
                    throw new Error("PROPERTY_21_COUNTEREXAMPLE " + JSON.stringify({
                        cards: scenario.cards,
                        rounds: scenario.rounds,
                        violations: result.violations,
                    }, null, 2));
                }
            }),
            { numRuns: 110 }
        );
    });
});
