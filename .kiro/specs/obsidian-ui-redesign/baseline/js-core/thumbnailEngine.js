// ============================================================
// core/thumbnailEngine.js — dedicated background thumbnail engine
// ------------------------------------------------------------
// Decoupled background thumbnail rendering pipeline for CompSaver.
// Handles serialized FIFO thumbnail renders, AerenderRunner delegation,
// in-project host fallback, 60s job budget, and retry mechanics.
// Cooperates with TextAnim when loaded to preserve single-flight AE
// rendering invariants across both template thumbnails and preset previews.
// ============================================================

(function (root) {
    "use strict";

    var DEFAULT_JOB_BUDGET_MS = 60000;
    var MAX_ATTEMPTS = 3;

    var queue = [];
    var running = false;
    var currentJob = null;

    function log(msg) {
        try { console.log("[CompSaver ThumbnailEngine] " + msg); } catch (e) { }
    }

    function warn(msg) {
        try { console.warn("[CompSaver ThumbnailEngine] " + msg); } catch (e) { }
    }

    function runOne(job, done) {
        var finished = false;
        var timer = null;

        function finish(err) {
            if (finished) return;
            finished = true;
            if (timer) {
                try { clearTimeout(timer); } catch (e) { }
                timer = null;
            }
            if (typeof root.clearFolderBusy === "function" && job.outPngPath) {
                var folder = ("" + job.outPngPath).replace(/\\/g, "/").replace(/\/[^\/]*$/, "");
                try { root.clearFolderBusy(folder); } catch (eF) { }
            }
            if (done) done(err);
        }

        if (typeof root.markFolderBusy === "function" && job.outPngPath) {
            var jobFolder = ("" + job.outPngPath).replace(/\\/g, "/").replace(/\/[^\/]*$/, "");
            try { root.markFolderBusy(jobFolder); } catch (eM) { }
        }

        timer = setTimeout(function () {
            warn("job timed out after " + DEFAULT_JOB_BUDGET_MS + "ms — abandoning");
            finish("thumbnail render timed out");
        }, DEFAULT_JOB_BUDGET_MS);

        var iface = root.csInterface || (typeof csInterface !== "undefined" ? csInterface : null);
        var hasHostBridge = !!(iface && typeof iface.evalScript === "function");
        var aerender = root.AerenderRunner || (typeof AerenderRunner !== "undefined" ? AerenderRunner : null);
        var isVideo = job.type === "video" || /\.(mp4|webm)$/i.test(job.outPngPath || "");

        function tryAerender(onDone) {
            if (!aerender || !job.compName) {
                if (onDone) onDone("AerenderRunner unavailable or compName missing");
                return;
            }
            try {
                aerender.renderThumbnail({
                    aepPath: job.aepPath,
                    compName: job.compName,
                    frame: (typeof job.renderFrame === "number" && job.renderFrame >= 0) ? job.renderFrame : 0,
                    outPngPath: job.outPngPath
                }, function (res) {
                    if (res && res.ok) {
                        if (onDone) onDone(null);
                        return;
                    }
                    var aeErr = (res && res.error) ? res.error : "Aerender failed";
                    warn("AerenderRunner returned error: " + aeErr);
                    if (onDone) onDone(aeErr);
                });
            } catch (eAe) {
                warn("AerenderRunner threw: " + eAe);
                if (onDone) onDone(eAe);
            }
        }

        function runInProject(onDone) {
            var encode = root.encodeBridge || (typeof encodeBridge === "function" ? encodeBridge : function (s) { return String(s); });
            var decode = root.decodeBridge || (typeof decodeBridge === "function" ? decodeBridge : function (s) { return String(s); });

            var frameArg = (typeof job.renderFrame === "number" && job.renderFrame >= 0) ? String(job.renderFrame) : "";
            var jsx = 'renderTemplateThumbnail("' +
                encode(job.aepPath) + '","' +
                encode(job.outPngPath) + '","' +
                encode(job.compName || "") + '","' +
                encode(frameArg) + '")';

            if (!iface || typeof iface.evalScript !== "function") {
                if (onDone) onDone("No CSInterface available");
                return;
            }

            try {
                iface.evalScript(jsx, function (raw) {
                    var res = {};
                    try { res = JSON.parse(decode(raw || "")); }
                    catch (e) { res = { ok: false, error: decode(raw || "") }; }
                    if (!res || !res.ok) {
                        var errStr = "AE thumbnail: " + (res && res.error ? res.error : "unknown error");
                        if (onDone) onDone(errStr);
                        return;
                    }
                    if (onDone) onDone(null);
                });
            } catch (eEval) {
                if (onDone) onDone("evalScript failed: " + (eEval && eEval.message ? eEval.message : eEval));
            }
        }

        // Fast path for static images (.png, .jpg): route through active host ExtendScript bridge first (<300ms)
        if (!isVideo && hasHostBridge) {
            runInProject(function (err) {
                if (!err) {
                    finish(null);
                    return;
                }
                warn("Host bridge thumbnail failed — checking aerender fallback: " + err);
                if (aerender && job.compName) {
                    tryAerender(function (aeErr) {
                        finish(aeErr ? err : null);
                    });
                } else {
                    finish(err);
                }
            });
            return;
        }

        // Multi-frame video preview or host bridge not present (e.g. Node test runner):
        if (aerender && job.compName) {
            tryAerender(function (aeErr) {
                if (!aeErr) {
                    finish(null);
                    return;
                }
                warn("AerenderRunner failed — falling back to host bridge: " + aeErr);
                runInProject(function (hostErr) {
                    finish(hostErr ? aeErr : null);
                });
            });
            return;
        }

        runInProject(finish);
    }

    function drainQueue() {
        if (!queue.length) {
            running = false;
            currentJob = null;
            return;
        }
        running = true;
        var job = queue.shift();
        currentJob = job;

        runOne(job, function (err) {
            if (currentJob === job) currentJob = null;
            if (err && job.attempt < MAX_ATTEMPTS) {
                job.attempt++;
                warn("retry " + job.attempt + "/" + MAX_ATTEMPTS + " for " + job.aepPath);
                queue.push(job);
                setTimeout(drainQueue, 200);
                return;
            }
            if (job.cb) {
                try { job.cb(err); } catch (eCb) { }
            }
            drainQueue();
        });
    }

    function enqueue(aepPath, outPngPath, onDone, compName, renderFrame) {
        if (!aepPath || !outPngPath) {
            if (onDone) onDone("no path");
            return;
        }

        // When TextAnim is present, delegate to its unified serialized queue so
        // thumbnails and text preset previews share FIFO execution and never overlap.
        var ta = root.TextAnim || (typeof TextAnim !== "undefined" ? TextAnim : null);
        if (ta && typeof ta.enqueueThumbnailRender === "function" && ta._usesThumbnailEngine !== true) {
            ta.enqueueThumbnailRender(aepPath, outPngPath, onDone, compName, renderFrame);
            return;
        }

        queue.push({
            type: "thumbnail",
            aepPath: aepPath,
            outPngPath: outPngPath,
            compName: compName || null,
            renderFrame: (typeof renderFrame === "number" && renderFrame >= 0) ? renderFrame : 0,
            cb: onDone,
            attempt: 1
        });

        if (!running) drainQueue();
    }

    var api = {
        enqueue: enqueue,
        runOne: runOne,
        isBusy: function () { return running || queue.length > 0; },
        queueLength: function () { return queue.length; },
        clear: function () { queue.length = 0; running = false; currentJob = null; }
    };

    root.ThumbnailEngine = api;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof window !== "undefined" ? window : global);
