// Lightweight timeline events and opt-in media scenario aggregation; no transport or persistence side effects.
(function (root) {
    "use strict";
    var listeners = [];
    var MEDIA_PHASES = {
        "picker return": true,
        "discovery": true,
        "card insertion": true,
        "copy": true,
        "thumbnail generation": true,
        "proxy generation": true,
        "catalog rendering": true,
        "panel interaction": true
    };
    // Startup phase whitelist. Separate from MEDIA_PHASES: the media scenario
    // metrics keep gating phase/recordLongWork on MEDIA_PHASES alone.
    var STARTUP_PHASES = {
        "startup.init": true,
        "startup.settings-restore": true,
        "startup.index-load": true,
        "startup.warm-paint": true,
        "startup.category-build": true,
        "startup.batch-append": true,
        "startup.validity-key": true,
        "startup.reconcile": true,
        "startup.bridge-scan": true,
        "startup.root-discovery": true,
        "startup.readiness": true,
        // Wave 2: the section-scoped first pass of the responsive cold start.
        "startup.section-scan": true
    };
    var VALIDITY_REASONS = {
        "fresh": "key-match",
        "stale": "key-mismatch",
        "unknown": "key-unavailable"
    };
    var activeStartupTrace = null;
    var startupTraceGeneration = 0;

    function now() {
        if (root.performance && typeof root.performance.now === "function") return root.performance.now();
        if (root.Date && typeof root.Date.now === "function") return root.Date.now();
        return Date.now();
    }
    function isFiniteNumber(value) {
        return typeof value === "number" && isFinite(value);
    }
    function emit(name, fields) {
        var event = { name: name, at: now(), fields: fields || {} };
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](event); } catch (e) { }
        }
        return event;
    }
    function span(name, fields) {
        var started = now(), ended = false;
        emit(name + ":start", fields);
        return {
            end: function (extra) {
                if (ended) return null;
                ended = true;
                var result = extra || {};
                result.durationMs = now() - started;
                return emit(name + ":end", result);
            }
        };
    }
    function subscribe(fn) {
        if (typeof fn !== "function") return function () { };
        listeners.push(fn);
        var active = true;
        return function () {
            if (!active) return;
            active = false;
            var i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
        };
    }
    function noopMetrics() {
        var noop = function () { return null; };
        return {
            start: noop, pickerResult: noop, recordPickerResult: noop,
            discoveryComplete: noop, recordDiscoveryComplete: noop,
            cardVisible: noop, recordCardVisible: noop, stageStart: noop,
            stageEnd: noop, observeLane: noop, observeProcessCount: noop,
            observeDecoderCount: noop, recordCardPatch: noop, phase: function (name, work) {
                return typeof work === "function" ? work() : null;
            },
            recordLongWork: noop, markUnavailable: noop, observeMemory: noop,
            finishScenario: noop, dispose: noop
        };
    }
    function readMemory() {
        var performanceMemory = root.performance && root.performance.memory;
        if (performanceMemory && isFiniteNumber(performanceMemory.usedJSHeapSize)) {
            return { available: true, bytes: performanceMemory.usedJSHeapSize, source: "performance.memory" };
        }
        if (root.process && typeof root.process.memoryUsage === "function") {
            try {
                var usage = root.process.memoryUsage();
                if (usage && isFiniteNumber(usage.heapUsed)) {
                    return { available: true, bytes: usage.heapUsed, source: "process.memoryUsage" };
                }
            } catch (e) { }
        }
        return { available: false, reason: "memory API unavailable" };
    }

    function createMediaScenarioMetrics(options) {
        options = options || {};
        if (options.enabled !== true) return noopMetrics();

        var scenario = null;
        var observer = null;
        var activePhase = null;
        var startedStages = {};
        var emitted = false;
        var finishedReport = null;

        function elapsed() { return now() - scenario.startedAt; }
        function unavailable(measurement, reason) {
            if (!scenario) return null;
            var entry = {
                scenario: scenario.kind,
                measurement: measurement,
                reason: reason || "unavailable"
            };
            scenario.unavailable.push(entry);
            return entry;
        }
        function observation(measurement, valueMs, details) {
            if (!scenario) return null;
            if (!isFiniteNumber(valueMs)) {
                unavailable(measurement, (details && details.reason) || "non-finite measurement");
                return null;
            }
            var item = {
                scenario: scenario.kind,
                measurement: measurement,
                valueMs: valueMs,
                available: true
            };
            if (details) {
                for (var key in details) {
                    if (Object.prototype.hasOwnProperty.call(details, key) && key !== "reason") item[key] = details[key];
                }
            }
            scenario.observations.push(item);
            return item;
        }
        function captureMemory(label) {
            var memory = readMemory();
            if (!memory.available) {
                unavailable("memory." + label, memory.reason);
                return null;
            }
            scenario.memory[label] = memory.bytes;
            scenario.memory.source = memory.source;
            if (!isFiniteNumber(scenario.memory.peak) || memory.bytes > scenario.memory.peak) {
                scenario.memory.peak = memory.bytes;
            }
            return memory.bytes;
        }
        function connectLongTaskObserver() {
            if (typeof root.PerformanceObserver !== "function") {
                unavailable("long-task observer", "PerformanceObserver unavailable");
                return;
            }
            try {
                observer = new root.PerformanceObserver(function (entries) {
                    var list = entries && typeof entries.getEntries === "function" ? entries.getEntries() : [];
                    for (var i = 0; i < list.length; i++) {
                        if (isFiniteNumber(list[i].duration) && list[i].duration > 50) {
                            scenario.longTasks.push({
                                phase: activePhase || "unattributed",
                                durationMs: list[i].duration,
                                source: "PerformanceObserver"
                            });
                        }
                    }
                });
                observer.observe({ entryTypes: ["longtask"] });
            } catch (e) {
                observer = null;
                unavailable("long-task observer", "longtask observation unavailable: " + String(e));
            }
        }
        function start(kind, protocolId, metadata) {
            if (scenario && !scenario.finished) return scenario;
            scenario = {
                kind: kind || "media-import",
                protocolId: protocolId || "",
                metadata: metadata || {},
                startedAt: now(),
                pickerResultMs: null,
                discoveryCompleteMs: null,
                firstCardVisibleMs: null,
                cardVisibility: [],
                stages: [],
                lanes: {},
                peaks: { ffmpegProcesses: 0, childProcesses: 0, videoDecoders: 0 },
                failedKeyedPatches: 0,
                longTasks: [],
                unavailable: [],
                memory: { before: null, peak: null, postIdle: null, source: null },
                observations: [],
                finished: false
            };
            emitted = false;
            finishedReport = null;
            startedStages = {};
            activePhase = null;
            captureMemory("before");
            connectLongTaskObserver();
            return scenario;
        }
        function recordRelative(field, measurement, mediaId) {
            if (!scenario) return null;
            var value = elapsed();
            if (field === "firstCardVisibleMs" && scenario[field] !== null) return scenario[field];
            scenario[field] = value;
            if (field === "firstCardVisibleMs") scenario.cardVisibility.push({ mediaId: mediaId || null, atMs: value });
            observation(measurement, value, mediaId ? { mediaId: mediaId } : null);
            return value;
        }
        function stageKey(stage, mediaId) { return String(stage) + "|" + String(mediaId || ""); }
        function stageStart(stage, mediaId) {
            if (!scenario) return null;
            var key = stageKey(stage, mediaId);
            startedStages[key] = { stage: stage, mediaId: mediaId || null, startedAt: now() };
            return startedStages[key];
        }
        function stageEnd(stage, mediaId, outcome, reason) {
            if (!scenario) return null;
            var key = stageKey(stage, mediaId);
            var started = startedStages[key];
            if (!started) {
                unavailable("stage." + stage + ".duration", "stage end without stage start");
                return null;
            }
            delete startedStages[key];
            var duration = now() - started.startedAt;
            var result = {
                stage: stage,
                mediaId: mediaId || null,
                startedMs: started.startedAt - scenario.startedAt,
                endedMs: now() - scenario.startedAt,
                durationMs: duration,
                outcome: outcome || "success"
            };
            if (reason) result.reason = reason;
            scenario.stages.push(result);
            observation("stage." + stage + ".duration", duration, {
                stage: stage,
                mediaId: mediaId || null,
                outcome: result.outcome
            });
            return result;
        }
        function observeLane(name, pending, active) {
            if (!scenario) return null;
            if (!isFiniteNumber(pending)) {
                unavailable("lane." + name + ".pending", "lane pending depth unavailable");
                return null;
            }
            var lane = scenario.lanes[name] || { maximumPendingDepth: 0, maximumActiveCount: 0 };
            lane.maximumPendingDepth = Math.max(lane.maximumPendingDepth, pending);
            if (isFiniteNumber(active)) lane.maximumActiveCount = Math.max(lane.maximumActiveCount, active);
            scenario.lanes[name] = lane;
            return lane;
        }
        function observePeak(field, count, measurement) {
            if (!scenario) return null;
            if (!isFiniteNumber(count)) {
                unavailable(measurement, "resource count unavailable");
                return null;
            }
            scenario.peaks[field] = Math.max(scenario.peaks[field], count);
            return scenario.peaks[field];
        }
        function recordCardPatch(ok, reason) {
            if (!scenario) return null;
            if (ok !== true) {
                scenario.failedKeyedPatches++;
                if (reason) scenario.failedKeyedPatchReasons = (scenario.failedKeyedPatchReasons || []).concat([reason]);
            }
            return scenario.failedKeyedPatches;
        }
        function recordLongWork(phaseName, durationMs, source) {
            if (!scenario) return null;
            if (!MEDIA_PHASES[phaseName]) {
                unavailable("long-task phase", "unknown phase: " + String(phaseName));
                return null;
            }
            if (!isFiniteNumber(durationMs)) {
                unavailable("long-task." + phaseName, "non-finite duration");
                return null;
            }
            if (durationMs > 50) {
                var entry = { phase: phaseName, durationMs: durationMs, source: source || "phase span" };
                scenario.longTasks.push(entry);
                return entry;
            }
            return null;
        }
        function phase(phaseName, work) {
            if (typeof work !== "function") {
                unavailable("phase." + phaseName, "phase work must be a function");
                return null;
            }
            if (!MEDIA_PHASES[phaseName]) {
                unavailable("phase." + phaseName, "unknown phase");
                return work();
            }
            var previous = activePhase;
            var begun = now();
            activePhase = phaseName;
            var result;
            try {
                result = work();
            } catch (error) {
                activePhase = previous;
                recordLongWork(phaseName, now() - begun, "phase span");
                throw error;
            }
            if (result && typeof result.then === "function") {
                return result.then(function (value) {
                    activePhase = previous;
                    recordLongWork(phaseName, now() - begun, "phase span");
                    return value;
                }, function (error) {
                    activePhase = previous;
                    recordLongWork(phaseName, now() - begun, "phase span");
                    throw error;
                });
            }
            activePhase = previous;
            recordLongWork(phaseName, now() - begun, "phase span");
            return result;
        }
        function finishScenario(idleSnapshot) {
            if (!scenario) return null;
            if (finishedReport) return finishedReport;
            scenario.finished = true;
            if (observer && typeof observer.disconnect === "function") observer.disconnect();
            observer = null;
            captureMemory("postIdle");
            idleSnapshot = idleSnapshot || {};
            if (isFiniteNumber(idleSnapshot.childProcesses)) scenario.peaks.postIdleChildProcesses = idleSnapshot.childProcesses;
            else if (Object.prototype.hasOwnProperty.call(idleSnapshot, "childProcesses")) unavailable("post-idle child processes", "non-finite resource count");
            if (isFiniteNumber(idleSnapshot.videoDecoders)) scenario.peaks.postIdleVideoDecoders = idleSnapshot.videoDecoders;
            else if (Object.prototype.hasOwnProperty.call(idleSnapshot, "videoDecoders")) unavailable("post-idle video decoders", "non-finite resource count");
            finishedReport = {
                kind: scenario.kind,
                protocolId: scenario.protocolId,
                durationMs: elapsed(),
                pickerResultMs: scenario.pickerResultMs,
                discoveryCompleteMs: scenario.discoveryCompleteMs,
                firstCardVisibleMs: scenario.firstCardVisibleMs,
                cardVisibility: scenario.cardVisibility.slice(),
                stages: scenario.stages.slice(),
                lanes: scenario.lanes,
                peaks: scenario.peaks,
                failedKeyedPatches: scenario.failedKeyedPatches,
                failedKeyedPatchReasons: scenario.failedKeyedPatchReasons || [],
                longTasks: scenario.longTasks.slice(),
                unavailable: scenario.unavailable.slice(),
                memory: scenario.memory,
                observations: scenario.observations.slice(),
                metadata: scenario.metadata
            };
            if (!emitted) {
                emitted = true;
                emit("media.scenario", finishedReport);
            }
            return finishedReport;
        }
        return {
            start: start,
            pickerResult: function () { return recordRelative("pickerResultMs", "picker.result", null); },
            recordPickerResult: function () { return recordRelative("pickerResultMs", "picker.result", null); },
            discoveryComplete: function () { return recordRelative("discoveryCompleteMs", "discovery.complete", null); },
            recordDiscoveryComplete: function () { return recordRelative("discoveryCompleteMs", "discovery.complete", null); },
            cardVisible: function (mediaId) { return recordRelative("firstCardVisibleMs", "card.first-visible", mediaId); },
            recordCardVisible: function (mediaId) { return recordRelative("firstCardVisibleMs", "card.first-visible", mediaId); },
            stageStart: stageStart,
            stageEnd: stageEnd,
            observeLane: observeLane,
            observeProcessCount: function (count) { return observePeak("ffmpegProcesses", count, "ffmpeg process peak"); },
            observeChildProcessCount: function (count) { return observePeak("childProcesses", count, "child process peak"); },
            observeDecoderCount: function (count) { return observePeak("videoDecoders", count, "video decoder peak"); },
            recordCardPatch: recordCardPatch,
            recordLongWork: recordLongWork,
            phase: phase,
            markUnavailable: unavailable,
            observeMemory: function () { return captureMemory("peak"); },
            finishScenario: finishScenario,
            dispose: function () { if (observer && typeof observer.disconnect === "function") observer.disconnect(); observer = null; }
        };
    }
    function MediaScenarioMetrics(options) { return createMediaScenarioMetrics(options); }
    MediaScenarioMetrics.create = createMediaScenarioMetrics;

    // ── Startup trace ────────────────────────────────────────────────────────
    // All startup timing arithmetic lives here. Callers only hand over names,
    // counts and decisions, so no consumer ever subtracts a trace value.
    function startupNowMs() {
        var t = now();
        if (typeof t !== "number" || !isFinite(t)) t = Date.now();
        return t;
    }
    function safeStartupString(value) {
        try { return String(value); } catch (e) { return ""; }
    }
    function safeStartupCount(value) {
        return isFiniteNumber(value) ? value : null;
    }
    function mergeStartupFields(base, extra) {
        var merged = {};
        var key;
        if (base && typeof base === "object") {
            for (key in base) {
                if (Object.prototype.hasOwnProperty.call(base, key)) merged[key] = base[key];
            }
        }
        if (extra && typeof extra === "object") {
            for (key in extra) {
                if (Object.prototype.hasOwnProperty.call(extra, key)) merged[key] = extra[key];
            }
        }
        return merged;
    }
    function readSinceNavigationMs() {
        try {
            var timing = root.performance && root.performance.timing;
            if (timing && isFiniteNumber(timing.navigationStart)) {
                var delta = Date.now() - timing.navigationStart;
                if (isFinite(delta)) return delta;
            }
        } catch (e) { }
        return null;
    }
    function formatStartupMs(value) {
        if (!isFiniteNumber(value)) return "n/a";
        return (Math.round(value * 10) / 10) + "ms";
    }
    function guardStartupMethod(fn) {
        return function (a, b, c) {
            try { return fn(a, b, c); } catch (e) { return null; }
        };
    }
    function inertStartupPhase() {
        return { end: function () { return null; } };
    }

    function createStartupTrace(options) {
        options = options || {};
        var startedAtMs = startupNowMs();
        var warmPainted = false;
        var report = {
            generation: isFiniteNumber(options.generation) ? options.generation : ++startupTraceGeneration,
            startedAtMs: startedAtMs,
            sinceNavigationMs: readSinceNavigationMs(),
            firstVisibleTemplateMs: null,
            firstFrameAfterPaintMs: null,
            firstVisibleTemplateCards: null,
            cache: { decision: null, reason: null },
            validity: { decision: null, reason: null, changedRoots: [] },
            bridgeScans: { total: 0, beforeWarmPaint: 0 },
            batches: { count: 0, cards: 0 },
            readiness: { state: null, checks: null, atMs: null },
            finalRerender: false,
            phases: [],
            unavailable: []
        };

        function elapsed() { return startupNowMs() - startedAtMs; }
        function markUnavailable(measurement, reason) {
            var entry = {
                measurement: safeStartupString(measurement),
                reason: (reason === null || reason === undefined || reason === "") ? "unavailable" : safeStartupString(reason)
            };
            report.unavailable.push(entry);
            return entry;
        }
        function beginPhase(name, fields) {
            var phaseName = safeStartupString(name);
            if (STARTUP_PHASES[phaseName] !== true) {
                markUnavailable("phase." + phaseName, "unknown phase");
                return inertStartupPhase();
            }
            var startFields = mergeStartupFields(null, fields);
            var began = startupNowMs();
            var handle = null;
            try { handle = span(phaseName, mergeStartupFields(null, startFields)); } catch (e) { handle = null; }
            var ended = false;
            return {
                end: function (extra) {
                    if (ended) return null;
                    ended = true;
                    var merged = mergeStartupFields(startFields, extra);
                    var durationMs = startupNowMs() - began;
                    var event = null;
                    if (handle && typeof handle.end === "function") {
                        try { event = handle.end(mergeStartupFields(null, merged)); } catch (e) { event = null; }
                    }
                    if (event && event.fields && isFiniteNumber(event.fields.durationMs)) durationMs = event.fields.durationMs;
                    if (!isFiniteNumber(durationMs)) durationMs = 0;
                    var record = { name: phaseName, durationMs: durationMs, fields: merged };
                    report.phases.push(record);
                    return record;
                }
            };
        }
        function noteWarmPaint(cardCount) {
            var cards = safeStartupCount(cardCount);
            if (report.firstVisibleTemplateMs === null) report.firstVisibleTemplateMs = elapsed();
            if (cards !== null || report.firstVisibleTemplateCards === null) {
                report.firstVisibleTemplateCards = cards === null ? 0 : cards;
            }
            warmPainted = true;
            if (report.firstFrameAfterPaintMs === null && typeof root.requestAnimationFrame === "function") {
                try {
                    root.requestAnimationFrame(function () {
                        if (report.firstFrameAfterPaintMs === null) report.firstFrameAfterPaintMs = elapsed();
                    });
                } catch (e) { }
            }
            return report.firstVisibleTemplateMs;
        }
        // cache.decision is "hit" or "miss"; cache.reason is the load reason
        // reported by the persistence layer, purely observational:
        //   "absent"             — no stored index payload
        //   "index-parsed"       — parsed with at least one entry
        //   "index-empty"        — parsed, zero entries
        //   "corrupt"            — no candidate payload verified
        //   "no-index-object"    — parsed, but no usable index object
        //   "recovered-staging"  — Wave 2: committed payload unusable, the staged
        //                          payload verified and was loaded (decision "hit")
        //   "recovered-previous" — Wave 2: committed and staged payloads unusable,
        //                          the previous-good payload verified (decision "hit")
        //   "version-ahead"      — Wave 2: payload written by a newer schema; its
        //                          entries are not consumed and it is left in
        //                          place (decision "miss")
        function noteCache(decision, reason) {
            report.cache = {
                decision: (decision === "hit" || decision === true) ? "hit" : "miss",
                reason: safeStartupString(reason)
            };
            return report.cache;
        }
        function noteValidity(decision, changedRoots, reason) {
            var normalized = (decision === "fresh" || decision === "stale") ? decision : "unknown";
            var roots = [];
            if (changedRoots && typeof changedRoots.length === "number") {
                for (var i = 0; i < changedRoots.length; i++) roots.push(safeStartupString(changedRoots[i]));
            }
            report.validity = {
                decision: normalized,
                reason: (typeof reason === "string" && reason) ? reason : VALIDITY_REASONS[normalized],
                changedRoots: roots
            };
            return report.validity;
        }
        function countBridgeScan(scannedRoot) {
            report.bridgeScans.total++;
            if (warmPainted !== true) report.bridgeScans.beforeWarmPaint++;
            return report.bridgeScans.total;
        }
        function noteBatch(cards) {
            var count = safeStartupCount(cards);
            report.batches.count++;
            report.batches.cards += (count === null ? 0 : count);
            return report.batches;
        }
        function noteReadiness(state, checks) {
            var count = safeStartupCount(checks);
            report.readiness = {
                state: safeStartupString(state),
                checks: count,
                atMs: elapsed()
            };
            return report.readiness;
        }
        function phaseSummary() {
            var parts = [];
            for (var i = 0; i < report.phases.length; i++) {
                parts.push(report.phases[i].name + "=" + formatStartupMs(report.phases[i].durationMs));
            }
            return parts.length ? parts.join(" ") : "none";
        }
        function print() {
            if (!root.console || typeof root.console.log !== "function") return null;
            var summary = "[CompSaver] startup trace gen " + report.generation +
                " | first-template " + formatStartupMs(report.firstVisibleTemplateMs) +
                " | first-frame " + formatStartupMs(report.firstFrameAfterPaintMs) +
                " | cards " + (report.firstVisibleTemplateCards === null ? "n/a" : report.firstVisibleTemplateCards) +
                " | cache " + (report.cache.decision || "n/a") + "/" + (report.cache.reason || "n/a") +
                " | validity " + (report.validity.decision || "n/a") + "/" + (report.validity.reason || "n/a") +
                " | scans " + report.bridgeScans.total + " (pre-warm-paint " + report.bridgeScans.beforeWarmPaint + ")" +
                " | batches " + report.batches.count + " (" + report.batches.cards + " cards)" +
                " | readiness " + (report.readiness.state || "n/a") + " @ " + formatStartupMs(report.readiness.atMs) +
                " | final-rerender " + (report.finalRerender === true) +
                " | unavailable " + report.unavailable.length +
                " | phases " + phaseSummary();
            root.console.log(summary);
            return summary;
        }

        return {
            beginPhase: function (name, fields) {
                try { return beginPhase(name, fields); } catch (e) { return inertStartupPhase(); }
            },
            noteWarmPaint: guardStartupMethod(noteWarmPaint),
            noteCache: guardStartupMethod(noteCache),
            noteValidity: guardStartupMethod(noteValidity),
            countBridgeScan: guardStartupMethod(countBridgeScan),
            noteBatch: guardStartupMethod(noteBatch),
            noteReadiness: guardStartupMethod(noteReadiness),
            markUnavailable: guardStartupMethod(markUnavailable),
            report: function () { return report; },
            print: guardStartupMethod(print)
        };
    }

    // One trace per startup, last startup wins.
    function beginStartupTrace(options) {
        var trace = createStartupTrace(options);
        activeStartupTrace = trace;
        try { root.__csStartupTrace = trace.report(); } catch (e) { }
        return trace;
    }

    var api = {
        emit: emit,
        span: span,
        subscribe: subscribe,
        createMediaScenarioMetrics: createMediaScenarioMetrics,
        MediaScenarioMetrics: MediaScenarioMetrics,
        mediaPhases: MEDIA_PHASES,
        startupPhases: STARTUP_PHASES,
        createStartupTrace: createStartupTrace,
        beginStartupTrace: beginStartupTrace,
        startupTrace: function () { return activeStartupTrace; }
    };
    root.PerfEvents = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);