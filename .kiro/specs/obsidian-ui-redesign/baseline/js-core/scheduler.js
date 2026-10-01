// Bounded FIFO scheduler. Media lanes add keyed operations, deferred work, and owned cleanup.
(function (root) {
    "use strict";

    function hasOwn(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    }

    function normalizeSourcePath(sourcePath) {
        return String(sourcePath === undefined || sourcePath === null ? "" : sourcePath)
            .replace(/\\/g, "/").replace(/\/+$/, "");
    }

    // Lane-level timeout defaults (milliseconds). The ffmpeg budget keeps its
    // legacy 60s value; the ae budget covers one job's full retry cycle
    // (3 attempts x 60s per-job budget) so a backlog of failing jobs can be
    // held hostage for at most one cycle before the lane is force-released.
    var FFMPEG_TIMEOUT_MS = 60000;
    var AE_LANE_TIMEOUT_MS = 180000;

    function configuredThumbnailConcurrency(options) {
        var value = options && (options.thumbnailConcurrency || options.thumbnailLimit ||
            options.thumbnailLaneConcurrency || options.thumbnail);
        if (value && typeof value === "object") value = value.concurrency || value.limit;
        if (options && options.lanes && options.lanes.thumbnail !== undefined) {
            var configuredLane = options.lanes.thumbnail;
            value = typeof configuredLane === "object" ?
                (configuredLane.concurrency || configuredLane.limit || value) : configuredLane;
        }
        return Number(value) === 2 ? 2 : 1;
    }

    function isSchedulerOptions(value) {
        return value && typeof value === "object" && !value.markWorkStart && !value.markWorkEnd &&
            (hasOwn(value, "thumbnail") || hasOwn(value, "thumbnailConcurrency") ||
                hasOwn(value, "thumbnailLimit") || hasOwn(value, "thumbnailLaneConcurrency") ||
                hasOwn(value, "lanes") || hasOwn(value, "ffmpegTimeoutMs") || hasOwn(value, "setTimeout"));
    }

    function createScheduler(lifecycle, configuration) {
        if (!configuration && isSchedulerOptions(lifecycle)) {
            configuration = lifecycle;
            lifecycle = null;
        }
        configuration = configuration || {};

        var lanes = Object.create ? Object.create(null) : {};
        var jobs = Object.create ? Object.create(null) : {};
        var keyedJobs = Object.create ? Object.create(null) : {};
        var nextId = 1, accepting = true;
        var setTimer = configuration.setTimeout || root.setTimeout;
        var clearTimer = configuration.clearTimeout || root.clearTimeout;
        var defaultFfmpegTimeout = Number(configuration.ffmpegTimeoutMs);

        if (!(defaultFfmpegTimeout >= 0)) defaultFfmpegTimeout = FFMPEG_TIMEOUT_MS;
        if (typeof setTimer !== "function" || typeof clearTimer !== "function") {
            throw new Error("Scheduler timers are unavailable");
        }

        function laneConcurrency(name, requested) {
            var concurrency = Math.floor(Number(requested));
            if (!(concurrency > 0)) concurrency = 1;
            if (name === "filesystem") return Math.min(2, concurrency);
            if (name === "ffmpeg") return 1;
            if (name === "thumbnail") return concurrency === 2 ? 2 : 1;
            return concurrency;
        }

        function createLane(name, options) {
            var requested = options && (options.concurrency || options.limit);
            var requestedTimeout = options ? options.timeoutMs : undefined;
            var hasTimeout = requestedTimeout !== null && requestedTimeout !== undefined &&
                Number(requestedTimeout) >= 0;
            if (lanes[name]) {
                // Allow the new thumbnail lane to be configured before it receives work.
                if (requested !== undefined && !lanes[name].active && !lanes[name].queue.length &&
                    !lanes[name].deferred && !lanes[name].cleaning) {
                    lanes[name].concurrency = laneConcurrency(name, requested);
                }
                // Lane-default timeout only affects jobs started after this call.
                if (hasTimeout) lanes[name].timeoutMs = Number(requestedTimeout);
                return lanes[name];
            }
            lanes[name] = {
                name: name,
                concurrency: laneConcurrency(name, requested),
                timeoutMs: hasTimeout ? Number(requestedTimeout) : null,
                active: 0,
                deferred: 0,
                cleaning: 0,
                queue: [],
                maxPending: 0,
                drainWaiters: []
            };
            return lanes[name];
        }

        function updatePendingPeak(lane) {
            var pending = lane.queue.length + lane.deferred;
            if (pending > lane.maxPending) lane.maxPending = pending;
        }

        function settleDrain(lane) {
            if (lane.active || lane.deferred || lane.cleaning || lane.queue.length) return;
            var waiters = lane.drainWaiters.splice(0);
            for (var i = 0; i < waiters.length; i++) waiters[i]();
        }

        function keyFor(options) {
            options = options || {};
            var hasStage = options.stage !== undefined;
            var hasMediaId = options.mediaId !== undefined || options.id !== undefined;
            var sourcePath = options.normalizedSourcePath;
            if (sourcePath === undefined) sourcePath = options.sourcePath;
            if (hasStage && hasMediaId && sourcePath !== undefined) {
                return String(options.stage) + "|" + String(options.mediaId === undefined ? options.id : options.mediaId) +
                    "|" + normalizeSourcePath(sourcePath);
            }
            return options.key === undefined || options.key === null ? "" : String(options.key);
        }

        function resolved(value) {
            return Promise.resolve(value);
        }

        function callCleanup(cleanup, resource) {
            try {
                return resolved(typeof cleanup === "function" ? cleanup(resource) : undefined).then(function () {
                    return undefined;
                }, function () {
                    // Cleanup is best-effort. The original job outcome remains authoritative.
                    return undefined;
                });
            } catch (error) {
                return resolved();
            }
        }

        function removeRecord(record) {
            if (jobs[record.id] === record) delete jobs[record.id];
            if (record.key && keyedJobs[record.key] === record) delete keyedJobs[record.key];
        }

        function removeQueuedRecord(record) {
            var queue = record.lane.queue;
            for (var i = 0; i < queue.length; i++) {
                if (queue[i] === record) {
                    queue.splice(i, 1);
                    return true;
                }
            }
            return false;
        }

        function releaseResource(entry) {
            if (!entry || entry.released) return false;
            entry.released = true;
            if (entry.removeListeners) entry.removeListeners();
            if (entry.releaseResolve) entry.releaseResolve();
            return true;
        }

        function registerResource(record, resource, cleanup, type) {
            var entry = {
                resource: resource,
                cleanup: cleanup,
                type: type || "resource",
                released: false
            };
            record.resources.push(entry);
            if (record.cancelled || record.finalizing || record.completed) {
                callCleanup(cleanup, resource).then(function () { releaseResource(entry); });
            }
            return resource;
        }

        function registerChildProcess(record, child) {
            var entry = {
                resource: child,
                type: "process",
                released: false,
                listeners: [],
                releasePromise: null,
                releaseResolve: null
            };
            entry.releasePromise = new Promise(function (resolve) { entry.releaseResolve = resolve; });
            entry.removeListeners = function () {
                if (!child || typeof child.removeListener !== "function") return;
                for (var i = 0; i < entry.listeners.length; i++) {
                    child.removeListener(entry.listeners[i].event, entry.listeners[i].listener);
                }
                entry.listeners = [];
            };
            function observe(eventName) {
                if (!child) return;
                var listener = function () { releaseResource(entry); };
                if (typeof child.once === "function") child.once(eventName, listener);
                else if (typeof child.on === "function") child.on(eventName, listener);
                else return;
                entry.listeners.push({ event: eventName, listener: listener });
            }
            observe("close");
            observe("exit");
            observe("error");
            entry.cleanup = function () {
                if (entry.released) return resolved();
                try {
                    if (child && typeof child.kill === "function") child.kill();
                } catch (error) { }
                // Plain process-like values have no observable close event; kill is their release.
                if (!entry.listeners.length) releaseResource(entry);
                return entry.releasePromise;
            };
            record.resources.push(entry);
            if (record.cancelled || record.finalizing || record.completed) entry.cleanup();
            return child;
        }

        function createControl(record) {
            var control = {
                isCancelled: function () { return record.cancelled; },
                onCancel: function (callback) {
                    if (typeof callback !== "function") return false;
                    if (record.cancelled) {
                        callCleanup(function () { return callback(record.reason, control); });
                    } else {
                        record.cancelHooks.push(callback);
                    }
                    return true;
                },
                registerCleanup: function (cleanup) {
                    return registerResource(record, null, cleanup, "cleanup");
                },
                registerResource: function (resource, cleanup) {
                    return registerResource(record, resource, cleanup, "resource");
                },
                registerStream: function (stream) {
                    return registerResource(record, stream, function (value) {
                        if (value && typeof value.destroy === "function") value.destroy();
                    }, "stream");
                },
                registerVideo: function (video) {
                    return registerResource(record, video, function (value) {
                        if (!value) return;
                        try { if (typeof value.pause === "function") value.pause(); } catch (error) { }
                        try { if (typeof value.removeAttribute === "function") value.removeAttribute("src"); } catch (ignore) { }
                        try { if (typeof value.load === "function") value.load(); } catch (ignored) { }
                    }, "video");
                },
                registerObjectUrl: function (url, revoke) {
                    return registerResource(record, url, function (value) {
                        var revokeUrl = revoke || (root.URL && root.URL.revokeObjectURL);
                        if (typeof revokeUrl === "function") revokeUrl.call(root.URL, value);
                    }, "object-url");
                },
                registerTimer: function (timer, clear) {
                    return registerResource(record, timer, function (value) {
                        (clear || clearTimer)(value);
                    }, "timer");
                },
                registerChildProcess: function (child) {
                    return registerChildProcess(record, child);
                },
                registerProcess: function (child) {
                    return registerChildProcess(record, child);
                },
                releaseProcess: function (child) {
                    for (var i = 0; i < record.resources.length; i++) {
                        var entry = record.resources[i];
                        if (entry.type === "process" && entry.resource === child) return releaseResource(entry);
                    }
                    return false;
                }
            };
            return control;
        }

        function invokeCancelHooks(record) {
            if (record.cancelHooksInvoked) return;
            record.cancelHooksInvoked = true;
            for (var i = 0; i < record.cancelHooks.length; i++) {
                (function (hook) {
                    record.cancelResults.push(callCleanup(function () {
                        return hook(record.reason, record.control);
                    }));
                })(record.cancelHooks[i]);
            }
        }

        function cleanupRecord(record) {
            if (record.cleanupPromise) return record.cleanupPromise;
            if (record.timeoutTimer !== null) {
                clearTimer(record.timeoutTimer);
                record.timeoutTimer = null;
            }
            var waits = record.cancelResults.slice(0);
            for (var i = 0; i < record.resources.length; i++) {
                (function (entry) {
                    if (entry.released) return;
                    waits.push(callCleanup(entry.cleanup, entry.resource).then(function () {
                        releaseResource(entry);
                    }));
                })(record.resources[i]);
            }
            record.cleanupPromise = Promise.all(waits).then(function () { return undefined; }, function () { return undefined; });
            return record.cleanupPromise;
        }

        function finish(record, kind, value) {
            if (record.finalizing || record.completed) return;
            record.finalizing = true;
            record.state = "cleaning";
            record.handle.state = "cleaning";
            record.lane.cleaning++;
            cleanupRecord(record).then(function () {
                record.lane.cleaning--;
                record.completed = true;
                record.state = kind === "cancel" ? "cancelled" : "settled";
                record.handle.state = record.state;
                if (record.started) {
                    record.lane.active--;
                    if (lifecycle && lifecycle.markWorkEnd) {
                        lifecycle.markWorkEnd("scheduler:" + record.lane.name, record.id);
                    }
                }
                removeRecord(record);
                if (kind === "reject") record.reject(value);
                else if (kind === "cancel") record.resolve({ cancelled: true, reason: record.reason });
                else record.resolve(value);
                pump(record.lane);
                settleDrain(record.lane);
            });
        }

        function requestCancel(record, reason) {
            if (!record || record.completed || record.finalizing || record.cancelled) return false;
            record.cancelled = true;
            record.reason = reason || "cancelled";
            invokeCancelHooks(record);
            if (record.state === "deferred") {
                if (record.timer !== null) clearTimer(record.timer);
                record.timer = null;
                record.lane.deferred--;
            } else if (record.state === "queued") {
                removeQueuedRecord(record);
            }
            finish(record, "cancel");
            return true;
        }

        // Timeout (ms) armed when a job starts. The ffmpeg lane keeps its
        // legacy precedence byte-for-byte: per-job ffmpegTimeoutMs, then
        // per-job timeoutMs, then the configured/default 60s budget. Every
        // other lane is protected by a per-job timeoutMs option or its
        // lane-level default (lane.timeoutMs); null leaves it unprotected.
        function laneTimeoutFor(lane, options) {
            if (lane.name === "ffmpeg") {
                var ffmpegTimeout = options.ffmpegTimeoutMs;
                if (!(Number(ffmpegTimeout) >= 0)) ffmpegTimeout = options.timeoutMs;
                if (!(Number(ffmpegTimeout) >= 0)) ffmpegTimeout = defaultFfmpegTimeout;
                return Number(ffmpegTimeout);
            }
            var timeout = options.timeoutMs;
            if (!(Number(timeout) >= 0) || timeout === null) timeout = lane.timeoutMs;
            // Number(null) === 0, so an unset lane default must stay unset.
            if (timeout === null || timeout === undefined || !(Number(timeout) >= 0)) return null;
            return Number(timeout);
        }

        function startRecord(record) {
            var lane = record.lane;
            record.started = true;
            record.state = "active";
            record.handle.state = "active";
            lane.active++;
            if (lifecycle && lifecycle.markWorkStart) lifecycle.markWorkStart("scheduler:" + lane.name, record.id);
            var timeout = laneTimeoutFor(lane, record.options);
            if (timeout !== null) {
                record.timeoutTimer = setTimer(function () {
                    requestCancel(record, lane.name + " timeout");
                }, timeout);
            }
            resolved().then(function () {
                if (record.cancelled) return undefined;
                return record.job(record.control);
            }).then(function (value) {
                if (!record.cancelled) finish(record, "resolve", value);
            }, function (error) {
                if (!record.cancelled) finish(record, "reject", error);
            });
        }

        function pump(lane) {
            while (accepting && lane.active < lane.concurrency && lane.queue.length) {
                var record = lane.queue.shift();
                if (record.cancelled) continue;
                startRecord(record);
            }
            settleDrain(lane);
        }

        function laneFor(laneName) {
            var lane = typeof laneName === "string" ? lanes[laneName] : laneName;
            if (!lane) throw new Error("Unknown scheduler lane: " + laneName);
            return lane;
        }

        function submit(laneName, job, options, delay) {
            var lane = laneFor(laneName);
            options = options || {};
            var key = keyFor(options);
            if (key && keyedJobs[key] && !keyedJobs[key].completed) return keyedJobs[key].handle;

            var resolvePromise, rejectPromise;
            var record = {
                id: "job-" + nextId++,
                lane: lane,
                job: job,
                options: options,
                key: key,
                owner: options.owner !== undefined ? options.owner :
                    (options.ownerId !== undefined ? options.ownerId : options.batchId),
                resolve: null,
                reject: null,
                promise: null,
                handle: null,
                state: delay === null ? "queued" : "deferred",
                started: false,
                cancelled: false,
                completed: false,
                finalizing: false,
                reason: "",
                timer: null,
                timeoutTimer: null,
                resources: [],
                cancelHooks: [],
                cancelHooksInvoked: false,
                cancelResults: [],
                cleanupPromise: null
            };
            record.promise = new Promise(function (resolve, reject) {
                resolvePromise = resolve;
                rejectPromise = reject;
            });
            record.resolve = resolvePromise;
            record.reject = rejectPromise;
            record.control = createControl(record);
            if (typeof options.onCancel === "function") record.cancelHooks.push(options.onCancel);
            if (options.process) record.control.registerChildProcess(options.process);
            record.handle = {
                id: record.id,
                key: key || null,
                lane: lane.name,
                promise: record.promise,
                state: record.state,
                cancel: function (reason) { return requestCancel(record, reason); }
            };
            jobs[record.id] = record;
            if (key) keyedJobs[key] = record;

            if (!accepting) {
                requestCancel(record, "scheduler disposed");
            } else if (delay === null) {
                lane.queue.push(record);
                updatePendingPeak(lane);
                pump(lane);
            } else {
                lane.deferred++;
                updatePendingPeak(lane);
                record.timer = setTimer(function () {
                    record.timer = null;
                    lane.deferred--;
                    if (record.cancelled || !accepting) {
                        if (!record.cancelled) requestCancel(record, "scheduler disposed");
                        return;
                    }
                    record.state = "queued";
                    record.handle.state = "queued";
                    lane.queue.push(record);
                    updatePendingPeak(lane);
                    pump(lane);
                }, Math.max(0, Number(delay) || 0));
            }
            return record.handle;
        }

        function enqueue(laneName, job, options) {
            return submit(laneName, job, options, null);
        }

        function defer(laneName, delayMs, job, options) {
            return submit(laneName, job, options, delayMs);
        }

        function cancel(id, reason) {
            return requestCancel(jobs[id], reason);
        }

        function cancelByOwner(owner, reason) {
            var ids = Object.keys(jobs), cancelled = 0;
            for (var i = 0; i < ids.length; i++) {
                var record = jobs[ids[i]];
                if (record && record.owner === owner && requestCancel(record, reason || "owner cancelled")) cancelled++;
            }
            return cancelled;
        }

        function drain(laneName) {
            var lane = typeof laneName === "string" ? lanes[laneName] : laneName;
            if (!lane || (!lane.active && !lane.deferred && !lane.cleaning && !lane.queue.length)) return resolved();
            return new Promise(function (resolve) { lane.drainWaiters.push(resolve); });
        }

        function resourceCounts(lane) {
            var counts = { resources: 0, processes: 0 };
            var ids = Object.keys(jobs);
            for (var i = 0; i < ids.length; i++) {
                var record = jobs[ids[i]];
                if (!record || record.lane !== lane) continue;
                for (var j = 0; j < record.resources.length; j++) {
                    if (record.resources[j].released) continue;
                    counts.resources++;
                    if (record.resources[j].type === "process") counts.processes++;
                }
            }
            return counts;
        }

        function snapshot() {
            var result = {
                accepting: accepting,
                active: 0,
                pending: 0,
                deferred: 0,
                timers: 0,
                processes: 0,
                lanes: {}
            };
            Object.keys(lanes).forEach(function (name) {
                var lane = lanes[name], resources = resourceCounts(lane);
                result.lanes[name] = {
                    limit: lane.concurrency,
                    concurrency: lane.concurrency,
                    active: lane.active,
                    pending: lane.queue.length + lane.deferred,
                    queued: lane.queue.length,
                    deferred: lane.deferred,
                    cleaning: lane.cleaning,
                    timers: lane.deferred,
                    maxPending: lane.maxPending,
                    ownedResources: resources.resources,
                    processes: resources.processes
                };
                result.active += lane.active;
                result.pending += lane.queue.length + lane.deferred;
                result.deferred += lane.deferred;
                result.timers += lane.deferred;
                result.processes += resources.processes;
            });
            return result;
        }

        function dispose() {
            if (!accepting) return false;
            accepting = false;
            Object.keys(jobs).forEach(function (id) {
                requestCancel(jobs[id], "scheduler disposed");
            });
            Object.keys(lanes).forEach(function (name) { settleDrain(lanes[name]); });
            return true;
        }

        createLane("filesystem", { concurrency: 2 });
        createLane("thumbnail", { concurrency: configuredThumbnailConcurrency(configuration) });
        createLane("ffmpeg", { concurrency: 1 });
        createLane("ae", { concurrency: 1, timeoutMs: AE_LANE_TIMEOUT_MS });

        return {
            createLane: createLane,
            enqueue: enqueue,
            defer: defer,
            cancel: cancel,
            cancelByOwner: cancelByOwner,
            drain: drain,
            dispose: dispose,
            snapshot: snapshot,
            metrics: snapshot,
            getMetrics: snapshot,
            keyFor: keyFor,
            normalizeSourcePath: normalizeSourcePath,
            lanes: lanes
        };
    }

    var singleton = createScheduler(root.AppLifecycle);
    singleton.createScheduler = createScheduler;
    singleton.FFMPEG_TIMEOUT_MS = FFMPEG_TIMEOUT_MS;
    singleton.AE_LANE_TIMEOUT_MS = AE_LANE_TIMEOUT_MS;
    root.Scheduler = singleton;
    if (root.AppLifecycle && root.AppLifecycle.onDispose) {
        root.AppLifecycle.onDispose(function () { singleton.dispose(); });
    }
    if (typeof module !== "undefined" && module.exports) module.exports = singleton;
})(typeof window !== "undefined" ? window : globalThis);