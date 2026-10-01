/**
 * Fast Media Engine
 * Implements instant import UX for raw media (Images/Videos)
 * and self-contained background copy to the library.
 */
(function (window, document) {
    "use strict";

    var fs = require("fs");
    var path = require("path");

    // =========================================================================
    // UI ENTRY POINTS
    // =========================================================================
    function initFastMediaEngine() {
        if (fastMediaDisposed || initFastMediaEngine._dispose) return false;
        var btnImportFile = document.getElementById("btn-import-file");
        var btnImportFolder = document.getElementById("btn-import-folder");
        function onImportFile(e) { e.stopPropagation(); openMediaPicker(false); }
        function onImportFolder(e) { e.stopPropagation(); openMediaPicker(true); }

        ensureProductionMediaRuntime();
        if (btnImportFile) btnImportFile.addEventListener("click", onImportFile);
        if (btnImportFolder) btnImportFolder.addEventListener("click", onImportFolder);
        initHoverPreviews();
        initFastMediaEngine._dispose = function () {
            if (btnImportFile) btnImportFile.removeEventListener("click", onImportFile);
            if (btnImportFolder) btnImportFolder.removeEventListener("click", onImportFolder);
            initFastMediaEngine._dispose = null;
        };
        return true;
    }

    function openMediaPicker(isFolder) {
        if (fastMediaDisposed) return;
        var generation = fastMediaGeneration;
        var scenarioToken = beginProductionScenario(isFolder ? "folder-import" : "single-import", { picker: true });
        var section = currentSection || "footage";

        var script = isFolder
            ? 'var f = Folder.selectDialog("Select Media Folder"); if(f) f.fsName; else "";'
            : 'var f = File.openDialog("Select Media File"); if(f) f.fsName; else "";';

        csInterface.evalScript(script, function (result) {
            if (fastMediaDisposed || generation !== fastMediaGeneration) return;
            recordProductionMetric("recordPickerResult");
            if (!result) {
                finishProductionScenario(scenarioToken, { cancelled: true });
                return;
            }

            var selectedPath = result.replace(/\\/g, "/");
            var operation = isFolder ? importMediaFolder(selectedPath, section, scenarioToken) :
                importMediaFile(selectedPath, section, null, scenarioToken);
            if (!operation || typeof operation.then !== "function") finishProductionScenario(scenarioToken, { unavailable: true });
        });
    }

    var THUMBNAIL_MAX_WIDTH = 320;
    var THUMBNAIL_MAX_HEIGHT = 180;
    var DECODE_TIMEOUT_MS = 10000;
    var FFMPEG_TIMEOUT_MS = 60000;
    var HOVER_INTENT_MS = 150;
    var HOVER_ACTIVATION_TIMEOUT_MS = 10000;
    var FAST_MEDIA_SCHEDULER_OWNER = "fast-media";
    var fastMediaDisposed = false;
    var fastMediaGeneration = 1;
    var unfinishedThumbnailResources = [];
    var mediaOwnedChildren = [];
    var mediaOwnedDisposables = [];
    var mediaSchedulerOwners = { "fast-media": true };
    var hoverPreviewController = null;
    var productionMediaRuntime = null;
    var productionScenarioToken = 0;
    var activeProductionScenario = 0;

    function mediaMetricsEnabled() {
        return window.__COMP_SAVER_MEDIA_INSTRUMENTATION__ === true ||
            window.COMP_SAVER_MEDIA_INSTRUMENTATION === true ||
            (window.PerfEvents && window.PerfEvents.mediaInstrumentationEnabled === true);
    }

    function removeMediaOwnedValue(list, value) {
        for (var i = list.length - 1; i >= 0; i--) {
            if (list[i] === value) list.splice(i, 1);
        }
    }

    function rememberMediaSchedulerOwner(owner) {
        if (owner === undefined || owner === null || owner === "") return;
        mediaSchedulerOwners[String(owner)] = true;
    }

    function rememberMediaDisposable(value) {
        if (!value || typeof value.dispose !== "function") return value;
        for (var i = 0; i < mediaOwnedDisposables.length; i++) {
            if (mediaOwnedDisposables[i] === value) return value;
        }
        mediaOwnedDisposables.push(value);
        return value;
    }

    function rememberMediaChild(child) {
        if (child) mediaOwnedChildren.push(child);
        return child;
    }

    function releaseMediaChild(child) {
        removeMediaOwnedValue(mediaOwnedChildren, child);
    }

    function cancelMediaSchedulerWork(reason) {
        var scheduler = window.Scheduler || (typeof Scheduler !== "undefined" ? Scheduler : null);
        var owners = Object.keys(mediaSchedulerOwners);
        if (!scheduler || typeof scheduler.cancelByOwner !== "function") return;
        for (var i = 0; i < owners.length; i++) {
            scheduler.cancelByOwner(owners[i], reason || "fast media disposed");
        }
    }

    function stopOwnedChildren() {
        var children = mediaOwnedChildren.slice();
        mediaOwnedChildren = [];
        for (var i = 0; i < children.length; i++) {
            try { if (children[i] && typeof children[i].kill === "function") children[i].kill(); } catch (ignoreKill) { }
        }
    }

    function fitThumbnailDimensions(sourceWidth, sourceHeight) {
        var width = Number(sourceWidth);
        var height = Number(sourceHeight);
        var scale;
        if (!(width > 0) || !(height > 0)) {
            return { width: 1, height: 1, scale: 0 };
        }
        scale = Math.min(1, THUMBNAIL_MAX_WIDTH / width, THUMBNAIL_MAX_HEIGHT / height);
        return {
            width: Math.max(1, Math.floor(width * scale)),
            height: Math.max(1, Math.floor(height * scale)),
            scale: scale
        };
    }

    function asyncMkdir(target) {
        var fsTarget = mediaWindowsLongPath(target);
        if (fs.promises && typeof fs.promises.mkdir === "function") {
            return fs.promises.mkdir(fsTarget, { recursive: true });
        }
        return new Promise(function (resolve, reject) {
            fs.mkdir(fsTarget, { recursive: true }, function (error) {
                if (error && error.code !== "EEXIST") reject(error); else resolve();
            });
        });
    }

    function asyncWriteFile(target, data, encoding) {
        var fsTarget = mediaWindowsLongPath(target);
        if (fs.promises && typeof fs.promises.writeFile === "function") {
            return fs.promises.writeFile(fsTarget, data, encoding);
        }
        return new Promise(function (resolve, reject) {
            fs.writeFile(fsTarget, data, encoding, function (error) {
                if (error) reject(error); else resolve();
            });
        });
    }

    function asyncStat(target) {
        var fsTarget = mediaWindowsLongPath(target);
        if (fs.promises && typeof fs.promises.stat === "function") return fs.promises.stat(fsTarget);
        if (typeof fs.stat !== "function") return Promise.resolve(null);
        return new Promise(function (resolve, reject) {
            fs.stat(fsTarget, function (error, stats) {
                if (error) reject(error); else resolve(stats);
            });
        });
    }

    function asyncRemove(target) {
        var fsTarget = mediaWindowsLongPath(target);
        if (fs.promises && typeof fs.promises.unlink === "function") {
            return fs.promises.unlink(fsTarget).catch(function () { return undefined; });
        }
        if (typeof fs.unlink !== "function") return Promise.resolve();
        return new Promise(function (resolve) {
            fs.unlink(fsTarget, function () { resolve(); });
        });
    }

    function standaloneControl() {
        return {
            isCancelled: function () { return false; },
            onCancel: function () { return false; },
            registerCleanup: function () { },
            registerResource: function (resource) { return resource; },
            registerStream: function (stream) { return stream; },
            registerVideo: function (video) { return video; },
            registerObjectUrl: function (url) { return url; },
            registerTimer: function (timer) { return timer; },
            registerChildProcess: function (child) { return child; },
            releaseProcess: function () { return true; }
        };
    }

    function enqueueMediaStage(lane, stage, mediaId, sourcePath, worker, options) {
        var schedulerOptions = options || {};
        if (fastMediaDisposed) return Promise.reject(new Error("FastMedia is disposed"));
        schedulerOptions.stage = stage;
        schedulerOptions.mediaId = mediaId;
        schedulerOptions.sourcePath = sourcePath;
        if (schedulerOptions.owner === undefined) schedulerOptions.owner = FAST_MEDIA_SCHEDULER_OWNER;
        rememberMediaSchedulerOwner(schedulerOptions.owner);
        if (typeof Scheduler !== "undefined" && Scheduler && typeof Scheduler.enqueue === "function") {
            return Scheduler.enqueue(lane, worker, schedulerOptions).promise;
        }
        return Promise.resolve().then(function () {
            if (fastMediaDisposed) throw new Error("FastMedia is disposed");
            return worker(standaloneControl());
        });
    }

    function copyFileStream(source, target, control) {
        return new Promise(function (resolve, reject) {
            var readStream;
            var writeStream;
            var settled = false;
            function fail(error) {
                if (settled) return;
                settled = true;
                try { if (readStream && typeof readStream.destroy === "function") readStream.destroy(); } catch (ignoreRead) { }
                try { if (writeStream && typeof writeStream.destroy === "function") writeStream.destroy(); } catch (ignoreWrite) { }
                asyncRemove(target).then(function () { reject(error); });
            }
            function complete() {
                if (settled) return;
                settled = true;
                resolve({ sourcePath: source, destinationPath: target });
            }
            try {
                readStream = fs.createReadStream(mediaWindowsLongPath(source));
                writeStream = fs.createWriteStream(mediaWindowsLongPath(target));
                if (control && control.registerStream) {
                    control.registerStream(readStream);
                    control.registerStream(writeStream);
                }
                if (control && control.onCancel) {
                    control.onCancel(function () {
                        try { if (readStream && typeof readStream.destroy === "function") readStream.destroy(); } catch (ignoreCancelRead) { }
                        try { if (writeStream && typeof writeStream.destroy === "function") writeStream.destroy(); } catch (ignoreCancelWrite) { }
                        return asyncRemove(target);
                    });
                }
                readStream.on("error", fail);
                writeStream.on("error", fail);
                writeStream.on("close", complete);
                readStream.pipe(writeStream);
            } catch (error) {
                fail(error);
            }
        });
    }

    function addOwnedListener(resources, target, eventName, listener) {
        if (target && typeof target.addEventListener === "function") {
            target.addEventListener(eventName, listener);
            resources.listeners.push({ target: target, eventName: eventName, listener: listener });
        } else if (target) {
            target["on" + eventName] = listener;
            resources.listeners.push({ target: target, eventName: eventName, listener: listener, property: true });
        }
    }

    function cleanupThumbnailResources(resources) {
        var i;
        var entry;
        if (!resources || resources.cleaned) return;
        resources.cleaned = true;
        removeMediaOwnedValue(unfinishedThumbnailResources, resources);
        if (resources.timeout !== null) {
            clearTimeout(resources.timeout);
            resources.timeout = null;
        }
        for (i = 0; i < resources.listeners.length; i++) {
            entry = resources.listeners[i];
            try {
                if (entry.property) entry.target["on" + entry.eventName] = null;
                else entry.target.removeEventListener(entry.eventName, entry.listener);
            } catch (ignoreListener) { }
        }
        resources.listeners = [];
        if (resources.video) {
            try { if (typeof resources.video.pause === "function") resources.video.pause(); } catch (ignorePause) { }
            try { resources.video.removeAttribute("src"); } catch (ignoreSource) { }
            try { if (typeof resources.video.load === "function") resources.video.load(); } catch (ignoreLoad) { }
            try {
                if (resources.video.parentNode) resources.video.parentNode.removeChild(resources.video);
            } catch (ignoreVideoNode) { }
        }
        if (resources.image) {
            try { resources.image.onload = null; resources.image.onerror = null; resources.image.src = ""; } catch (ignoreImage) { }
        }
        for (i = 0; i < resources.objectUrls.length; i++) {
            try {
                if (window.URL && typeof window.URL.revokeObjectURL === "function") {
                    window.URL.revokeObjectURL(resources.objectUrls[i]);
                }
            } catch (ignoreUrl) { }
        }
        resources.objectUrls = [];
        if (resources.canvas) {
            try { resources.canvas.width = 0; resources.canvas.height = 0; } catch (ignoreCanvas) { }
        }
        resources.video = null;
        resources.canvas = null;
        resources.context = null;
        resources.image = null;
        resources.blob = null;
        resources.encodedImage = null;
    }

    function createThumbnailResources(control) {
        var resources = {
            video: null,
            canvas: null,
            context: null,
            image: null,
            blob: null,
            encodedImage: null,
            objectUrls: [],
            listeners: [],
            timeout: null,
            cleaned: false
        };
        unfinishedThumbnailResources.push(resources);
        if (control && control.registerCleanup) {
            control.registerCleanup(function () { cleanupThumbnailResources(resources); });
        }
        if (control && control.onCancel) {
            control.onCancel(function () { cleanupThumbnailResources(resources); });
        }
        return resources;
    }

    function writeThumbnailDataUrl(destThumb, dataUrl) {
        var base64Data = String(dataUrl || "").replace(/^data:image\/png;base64,/, "");
        return asyncWriteFile(destThumb, base64Data, "base64");
    }

    function generateImageThumbnail(sourceImage, destThumb, control) {
        return new Promise(function (resolve, reject) {
            var resources = createThumbnailResources(control);
            var settled = false;
            function fail(error) {
                if (settled) return;
                settled = true;
                cleanupThumbnailResources(resources);
                reject(error);
            }
            function succeed(result) {
                if (settled) return;
                settled = true;
                cleanupThumbnailResources(resources);
                resolve(result);
            }
            try {
                resources.canvas = document.createElement("canvas");
                resources.canvas.width = 1;
                resources.canvas.height = 1;
                resources.image = new Image();
                addOwnedListener(resources, resources.image, "load", function () {
                    var fitted;
                    try {
                        fitted = fitThumbnailDimensions(resources.image.naturalWidth || resources.image.width,
                            resources.image.naturalHeight || resources.image.height);
                        resources.canvas.width = fitted.width;
                        resources.canvas.height = fitted.height;
                        resources.context = resources.canvas.getContext("2d");
                        if (!resources.context) throw new Error("Canvas context unavailable");
                        resources.context.drawImage(resources.image, 0, 0, fitted.width, fitted.height);
                        resources.encodedImage = resources.canvas.toDataURL("image/png");
                    } catch (error) {
                        fail(error);
                        return;
                    }
                    writeThumbnailDataUrl(destThumb, resources.encodedImage).then(function () {
                        succeed({ ok: true, path: destThumb, width: fitted.width, height: fitted.height });
                    }, fail);
                });
                addOwnedListener(resources, resources.image, "error", function () {
                    fail(new Error("Image decoding failed"));
                });
                resources.timeout = setTimeout(function () {
                    fail(new Error("Image decoding timed out"));
                }, DECODE_TIMEOUT_MS);
                resources.image.src = "file:///" + encodeURI(sourceImage);
            } catch (error) {
                fail(error);
            }
        });
    }

    function extractVideoFrame(videoPath, timeInSeconds, destThumb, control) {
        return new Promise(function (resolve, reject) {
            var resources = createThumbnailResources(control);
            var settled = false;
            function fail(error) {
                if (settled) return;
                settled = true;
                cleanupThumbnailResources(resources);
                reject(error);
            }
            function succeed(result) {
                if (settled) return;
                settled = true;
                cleanupThumbnailResources(resources);
                resolve(result);
            }
            try {
                resources.video = document.createElement("video");
                resources.video.muted = true;
                resources.video.crossOrigin = "anonymous";
                addOwnedListener(resources, resources.video, "loadeddata", function () {
                    if (resources.video.duration < timeInSeconds) timeInSeconds = 0;
                    resources.video.currentTime = timeInSeconds;
                });
                addOwnedListener(resources, resources.video, "error", function () {
                    fail(new Error("HTML5 video decoding failed"));
                });
                addOwnedListener(resources, resources.video, "seeked", function () {
                    var fitted;
                    try {
                        fitted = fitThumbnailDimensions(resources.video.videoWidth, resources.video.videoHeight);
                        resources.canvas = document.createElement("canvas");
                        resources.canvas.width = fitted.width;
                        resources.canvas.height = fitted.height;
                        resources.context = resources.canvas.getContext("2d");
                        if (!resources.context) throw new Error("Canvas context unavailable");
                        resources.context.drawImage(resources.video, 0, 0, fitted.width, fitted.height);
                        resources.encodedImage = resources.canvas.toDataURL("image/png");
                    } catch (error) {
                        fail(error);
                        return;
                    }
                    writeThumbnailDataUrl(destThumb, resources.encodedImage).then(function () {
                        succeed({ ok: true, path: destThumb, width: fitted.width, height: fitted.height });
                    }, fail);
                });
                resources.timeout = setTimeout(function () {
                    fail(new Error("Video decoding timed out"));
                }, DECODE_TIMEOUT_MS);
                resources.video.src = "file:///" + encodeURI(videoPath);
            } catch (error) {
                fail(error);
            }
        });
    }

    function generateFallbackThumbnail(destThumb, fileName, control) {
        return new Promise(function (resolve, reject) {
            var resources = createThumbnailResources(control);
            try {
                resources.canvas = document.createElement("canvas");
                resources.canvas.width = THUMBNAIL_MAX_WIDTH;
                resources.canvas.height = THUMBNAIL_MAX_HEIGHT;
                resources.context = resources.canvas.getContext("2d");
                if (!resources.context) throw new Error("Canvas context unavailable");
                resources.context.fillStyle = "#2d2d2d";
                resources.context.fillRect(0, 0, THUMBNAIL_MAX_WIDTH, THUMBNAIL_MAX_HEIGHT);
                resources.context.fillStyle = "rgba(255,255,255,0.8)";
                resources.context.beginPath();
                resources.context.moveTo(140, 60);
                resources.context.lineTo(195, 90);
                resources.context.lineTo(140, 120);
                resources.context.closePath();
                resources.context.fill();
                resources.context.fillStyle = "#aaaaaa";
                resources.context.font = "12px Arial, sans-serif";
                resources.context.textAlign = "center";
                resources.context.fillText(String(fileName || "").replace(/[&<>'"]/g, ""), 160, 154, 290);
                resources.encodedImage = resources.canvas.toDataURL("image/png");
            } catch (error) {
                cleanupThumbnailResources(resources);
                reject(error);
                return;
            }
            writeThumbnailDataUrl(destThumb, resources.encodedImage).then(function () {
                cleanupThumbnailResources(resources);
                resolve({ ok: true, path: destThumb, width: 320, height: 180, fallback: true });
            }, function (error) {
                cleanupThumbnailResources(resources);
                reject(error);
            });
        });
    }

    function resolveFfmpegExecutable() {
        return new Promise(function (resolve) {
            if (typeof window.resolveFfmpeg !== "function") {
                resolve("");
                return;
            }
            try {
                window.resolveFfmpeg(function (executable) { resolve(executable || ""); });
            } catch (error) {
                resolve("");
            }
        });
    }

    function validProxyCache(destMedia, destProxy) {
        return Promise.all([
            asyncStat(destMedia).catch(function () { return null; }),
            asyncStat(destProxy).catch(function () { return null; })
        ]).then(function (stats) {
            var mediaStat = stats[0];
            var proxyStat = stats[1];
            if (!mediaStat || !proxyStat) return false;
            return Number(proxyStat.mtimeMs || proxyStat.mtime) >= Number(mediaStat.mtimeMs || mediaStat.mtime);
        });
    }

    function executeFfmpeg(executable, args, control) {
        return new Promise(function (resolve, reject) {
            var cp;
            var child;
            var timer = null;
            var settled = false;
            var callbackPending = false;
            var callbackError = null;
            function settle(error, processExited) {
                if (settled) return;
                settled = true;
                if (timer !== null) clearTimeout(timer);
                timer = null;
                if (processExited && child && control && control.releaseProcess) control.releaseProcess(child);
                releaseMediaChild(child);
                child = null;
                if (error) reject(error); else resolve();
            }
            try {
                cp = require("child_process");
                child = cp.execFile(executable, args, { timeout: FFMPEG_TIMEOUT_MS }, function (error) {
                    if (!child) {
                        callbackPending = true;
                        callbackError = error || null;
                        return;
                    }
                    settle(error || null, true);
                });
                rememberMediaChild(child);
                if (control && control.registerChildProcess) control.registerChildProcess(child);
                if (callbackPending) {
                    settle(callbackError, true);
                    return;
                }
                if (control && control.onCancel) {
                    control.onCancel(function () {
                        try { if (child && typeof child.kill === "function") child.kill(); } catch (ignoreKill) { }
                    });
                }
                timer = setTimeout(function () {
                    var timeoutError = new Error("FFmpeg execution timed out");
                    timeoutError.code = "FFMPEG_TIMEOUT";
                    try { if (child && typeof child.kill === "function") child.kill(); } catch (ignoreTimeoutKill) { }
                    settle(timeoutError, false);
                }, FFMPEG_TIMEOUT_MS);
            } catch (error) {
                settle(error, true);
            }
        });
    }

    function runFfmpegFallback(destMedia, categoryDir, safeName, control) {
        var destThumb = path.join(categoryDir, "thumbnail.png").replace(/\\/g, "/");
        var destProxy = path.join(categoryDir, "proxy.mp4").replace(/\\/g, "/");
        return resolveFfmpegExecutable().then(function (ffmpeg) {
            if (!ffmpeg) {
                return { ok: false, status: "derivative-unavailable", reason: "ffmpeg-unavailable" };
            }
            if (control && control.isCancelled && control.isCancelled()) {
                return { ok: false, status: "derivative-unavailable", reason: "cancelled" };
            }
            return validProxyCache(destMedia, destProxy).then(function (cached) {
                if (cached) return { ok: true, status: "cached", proxyPath: destProxy, thumbnailPath: destThumb };
                var thumbArgs = ["-i", destMedia, "-vframes", "1", "-vf",
                    "scale=320:180:force_original_aspect_ratio=decrease", "-y", destThumb];
                return executeFfmpeg(ffmpeg, thumbArgs, control).then(function () {
                    return true;
                }, function () {
                    return false;
                }).then(function (thumbnailCreated) {
                    var proxyArgs;
                    if (control && control.isCancelled && control.isCancelled()) {
                        return { ok: false, status: "derivative-unavailable", reason: "cancelled" };
                    }
                    proxyArgs = ["-i", destMedia, "-vf", "scale=-2:360", "-vcodec", "libx264",
                        "-crf", "28", "-preset", "ultrafast", "-y", destProxy];
                    return executeFfmpeg(ffmpeg, proxyArgs, control).then(function () {
                        return {
                            ok: true,
                            status: "generated",
                            proxyPath: destProxy,
                            thumbnailPath: thumbnailCreated ? destThumb : ""
                        };
                    });
                });
            }).catch(function (error) {
                return {
                    ok: false,
                    status: "derivative-unavailable",
                    reason: error && error.code === "FFMPEG_TIMEOUT" ? "ffmpeg-timeout" : "ffmpeg-failed",
                    error: error
                };
            });
        });
    }

    function generateFfmpegFallback(destMedia, categoryDir, safeName, mediaId, sourcePath) {
        var id = mediaId || safeName;
        return enqueueMediaStage("ffmpeg", "ffmpeg-proxy", id, sourcePath || destMedia, function (control) {
            return runFfmpegFallback(destMedia, categoryDir, safeName, control);
        }, { ffmpegTimeoutMs: FFMPEG_TIMEOUT_MS });
    }

    // =========================================================================
    // MEDIA IMPORT/WORK COORDINATORS (Task 7.1; entry-point wiring is Task 10.1)
    // =========================================================================
    // FIX 7: this allowlist used to be NARROWER than the host's. The host
    // accepts png|jpg|jpeg|gif|bmp|tiff|tif|svg|webp|ico for images and
    // mp4|mov|avi|mkv|webm|m4v|mpg|mpeg|wmv|flv|mxf for video
    // in the ExtendScript host allowlist, so folder ingestion silently skipped
    // bmp, tif, tiff, svg, ico, mkv, m4v, mpg, mpeg, wmv, flv and mxf even
    // though After Effects would have imported every one of them. The table now
    // matches the host exactly; PLACEHOLDER_FALLBACK_IMAGE_EXTENSIONS below
    // covers the thumbnail consequence of the newly admitted image formats.
    var SUPPORTED_MEDIA_EXTENSIONS = {
        ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
        ".bmp": "image", ".tif": "image", ".tiff": "image", ".svg": "image", ".ico": "image",
        ".mp4": "video", ".mov": "video", ".webm": "video", ".avi": "video",
        ".mkv": "video", ".m4v": "video", ".mpg": "video", ".mpeg": "video",
        ".wmv": "video", ".flv": "video", ".mxf": "video"
    };

    // Image formats whose thumbnail may not survive the CEF <img> + canvas
    // decoder, and which are therefore allowed to degrade to the same drawn
    // placeholder the video branch has always used (see _defaultThumbnail).
    //
    // Why this list is needed: _defaultThumbnail routes on item.isVideo, and the
    // IMAGE branch has no fallback — a rejected generateImageThumbnail returns
    // { ok:false, status:"derivative-unavailable" } and the card stays blank
    // forever. Chromium ships no TIFF decoder at all, and an SVG with no
    // intrinsic width/height reports naturalWidth/naturalHeight 0, which
    // fitThumbnailDimensions collapses to a 1x1 canvas — blank either way.
    // Admitting those extensions without a fallback would swap one silent
    // failure (dropped file) for another (permanently blank card), which is the
    // symptom this fix exists to remove.
    //
    // Scope is deliberately limited to the extensions FIX 7 newly admits. The
    // five formats that already worked (.png/.jpg/.jpeg/.webp/.gif) keep the
    // historical no-fallback reply, which Property 12 in
    // tests/media-thumbnail-resources.property.test.js pins ("image decode
    // failure invoked a codec fallback" is a violation there).
    var PLACEHOLDER_FALLBACK_IMAGE_EXTENSIONS = {
        ".bmp": true, ".tif": true, ".tiff": true, ".svg": true, ".ico": true
    };

    // FIX 6 — bounds for the recursive folder walk in _expandCandidate.
    // Recursion makes traversal unbounded, so every axis that can run away has
    // a named cap:
    //   DEPTH       — directory levels below the picked folder. 8 covers the
    //                 project/shot/take/date trees an editor actually hands a
    //                 panel, and refuses to walk an accidentally picked volume
    //                 root to the bottom.
    //   FILES       — files EXAMINED (not accepted). Bounds the stat() count,
    //                 which is the real cost. A folder holding more than this
    //                 many files imports the first FILES it reaches; the walk
    //                 then stops rather than freezing the panel.
    //   DIRECTORIES — directories READ. Depth alone does not bound breadth, and
    //                 a tree of empty folders adds no files, so the readdir()
    //                 count needs its own cap.
    //   STAT_BATCH  — stat() calls in flight at once. The pre-fix code fired
    //                 one Promise.all over every child of ONE folder; recursing
    //                 the same way would multiply that by the whole tree, so
    //                 children are classified in slices of this size instead.
    var MEDIA_DISCOVERY_MAX_DEPTH = 8;
    var MEDIA_DISCOVERY_MAX_FILES = 5000;
    var MEDIA_DISCOVERY_MAX_DIRECTORIES = 2000;
    var MEDIA_DISCOVERY_STAT_BATCH = 32;

    var mediaCoordinatorSequence = 0;

    // M4 fix: per-panel session nonce for the DEFAULT mediaId scheme. The
    // previous id (millisecond + per-panel counter) could be minted twice —
    // two panels open in the same millisecond with equal counters produce
    // IDENTICAL ids, hence identical mediaIdFolderSegment folders and two
    // writers in one media folder. The nonce is captured once per panel
    // session at module init and mixed into every default id. Nothing parses
    // id structure (folder segments expand any char set; meta.json/index
    // match on the whole id string), so existing ids stay valid. The 4 added
    // chars grow the folder segment by only 20 chars; the M9 filename cap
    // and the \\?\ write-boundary keep the assembled path creatable.
    var mediaSessionNonce = (function () {
        var bits;
        try {
            bits = Math.floor(Math.random() * 0x10000);
        } catch (e) {
            bits = Math.floor(new Date().getTime() % 0x10000);
        }
        var hex = bits.toString(16);
        while (hex.length < 4) hex = "0" + hex;
        return hex;
    })();

    function mediaOwn(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    }

    function mediaArray(value) {
        return Object.prototype.toString.call(value) === "[object Array]";
    }

    function canonicalizeMediaSourcePath(value) {
        var source = String(value === undefined || value === null ? "" : value).replace(/\\/g, "/");
        var prefix = "";
        var absolute = false;
        var parts;
        var output = [];
        var i;
        if (/^[A-Za-z]:\//.test(source)) {
            prefix = source.substring(0, 2).charAt(0).toUpperCase() + ":";
            source = source.substring(2);
            absolute = true;
        } else if (source.indexOf("//") === 0) {
            prefix = "//";
            source = source.substring(2);
            absolute = true;
        } else if (source.charAt(0) === "/") {
            prefix = "/";
            source = source.substring(1);
            absolute = true;
        }
        parts = source.split("/");
        for (i = 0; i < parts.length; i++) {
            if (!parts[i] || parts[i] === ".") continue;
            if (parts[i] === "..") {
                if (output.length && output[output.length - 1] !== "..") output.pop();
                else if (!absolute) output.push("..");
            } else {
                output.push(parts[i]);
            }
        }
        if (prefix === "//") source = "//" + output.join("/");
        else if (prefix === "/") source = "/" + output.join("/");
        else if (prefix) source = prefix + "/" + output.join("/");
        else source = output.join("/");
        return source.replace(/\/+$/, "");
    }

    function mediaPathIdentity(value, caseInsensitive) {
        var normalized = canonicalizeMediaSourcePath(value);
        var windowsPath = /^[A-Za-z]:($|\/)/.test(normalized) || normalized.indexOf("//") === 0;
        return caseInsensitive || windowsPath ? normalized.toLowerCase() : normalized;
    }

    function mediaPathJoin() {
        var joined = "";
        for (var i = 0; i < arguments.length; i++) {
            var part = String(arguments[i] === undefined || arguments[i] === null ? "" : arguments[i]);
            if (!part) continue;
            joined += (joined && !/\/$/.test(joined) ? "/" : "") + part.replace(/^\/+/, "");
        }
        return canonicalizeMediaSourcePath(joined);
    }

    function mediaSafeName(value, fallback) {
        var safe = String(value || "").replace(/[<>:"/\\|?*]+/g, "_").replace(/^\s+|\s+$/g, "");
        return safe || fallback;
    }

    function mediaIdFolderSegment(id) {
        var value = String(id);
        var encoded = "media";
        for (var i = 0; i < value.length; i++) {
            var code = value.charCodeAt(i).toString(16);
            while (code.length < 4) code = "0" + code;
            encoded += "-" + code;
        }
        return encoded;
    }

    // M9 fix: Windows MAX_PATH (260) guard for media storage paths.
    // mediaIdFolderSegment expands an id to ~85-105 chars and deep library
    // roots add another 100-150, so assembled destination paths can exceed
    // MAX_PATH (ENAMETOOLONG / silent import failures). Two additive,
    // backward-compatible layers protect the writes:
    //   1. mediaStorageFileName caps the source filename's contribution with
    //      a deterministic fingerprint so the assembled path fits the budget;
    //   2. mediaWindowsLongPath prefixes Windows absolute paths with \\?\ at
    //      the filesystem boundary whenever the assembled path still exceeds
    //      the budget — extended-length paths bypass MAX_PATH in every Win32
    //      API Node's fs uses here (mkdir/writeFile/stat/unlink/streams).
    // Canonical paths stored in the index keep their forward-slash shape —
    // the prefix is applied only to the value handed to fs, so existing
    // folders keep resolving unchanged. The gate is the PATH SHAPE (drive
    // letter or UNC), which POSIX paths never carry, so non-Windows builds
    // no-op without needing a platform probe (the CEP panel has no
    // `process`).
    var MEDIA_PATH_LENGTH_BUDGET = 240;

    function mediaLooksLikeWindowsPath(value) {
        return /^[A-Za-z]:[/\\]/.test(value) || value.indexOf("//") === 0 || value.indexOf("\\\\") === 0;
    }

    function mediaWindowsLongPath(target) {
        var value = String(target === undefined || target === null ? "" : target);
        if (value.length <= MEDIA_PATH_LENGTH_BUDGET || !mediaLooksLikeWindowsPath(value)) return value;
        if (value.indexOf("\\\\?\\") === 0) return value;
        var backslashed = value.replace(/\//g, "\\");
        if (backslashed.indexOf("\\\\") === 0) return "\\\\?\\UNC\\" + backslashed.substring(2);
        return "\\\\?\\" + backslashed;
    }

    // FNV-1a (32-bit) fingerprint of a filename — deterministic 8-hex chars,
    // ES5-safe (no Math.imul), used to keep capped filenames unique.
    function mediaNameFingerprint(value) {
        var hash = 0x811c9dc5;
        var text = String(value);
        for (var i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            // hash * 16777619 (FNV prime) via shifts: 1+2+16+128+256+16777216.
            hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
        }
        var hex = hash.toString(16);
        while (hex.length < 8) hex = "0" + hex;
        return hex;
    }

    // Cap the stored filename so root + section + category + id segment +
    // filename stays within MEDIA_PATH_LENGTH_BUDGET. Deterministic: keep the
    // extension, truncate the stem, append an 8-char fingerprint of the FULL
    // name for uniqueness. Identity/dedupe keys are derived from the SOURCE
    // path (mediaPathIdentity / the repository's sourcePath), never from the
    // stored filename, so capping cannot split or merge imports.
    function mediaStorageFileName(fileName, destinationFolder) {
        var name = String(fileName === undefined || fileName === null ? "" : fileName);
        if (!name) return name;
        var folder = String(destinationFolder || "");
        if (mediaPathJoin(folder, name).length <= MEDIA_PATH_LENGTH_BUDGET) return name;
        var dot = name.lastIndexOf(".");
        var extension = dot > 0 && name.length - dot <= 12 ? name.substring(dot) : "";
        var stem = extension ? name.substring(0, dot) : name;
        var fingerprint = "-" + mediaNameFingerprint(name);
        var stemBudget = MEDIA_PATH_LENGTH_BUDGET - (folder.length + 1 + fingerprint.length + extension.length);
        if (stemBudget < 1) stemBudget = 1;
        if (stem.length > stemBudget) stem = stem.substring(0, stemBudget);
        return stem + fingerprint + extension;
    }

    function mediaAsyncStat(fsImpl, target) {
        var fsTarget = mediaWindowsLongPath(target);
        return new Promise(function (resolve) {
            if (!fsImpl) { resolve(null); return; }
            if (fsImpl.promises && typeof fsImpl.promises.stat === "function") {
                fsImpl.promises.stat(fsTarget).then(resolve, function () { resolve(null); });
                return;
            }
            if (typeof fsImpl.stat !== "function") { resolve(null); return; }
            try {
                fsImpl.stat(fsTarget, function (error, stats) { resolve(error ? null : stats); });
            } catch (error) { resolve(null); }
        });
    }

    function mediaAsyncReadDir(fsImpl, target) {
        var fsTarget = mediaWindowsLongPath(target);
        return new Promise(function (resolve) {
            if (!fsImpl) { resolve([]); return; }
            if (fsImpl.promises && typeof fsImpl.promises.readdir === "function") {
                fsImpl.promises.readdir(fsTarget).then(function (names) { resolve(mediaArray(names) ? names : []); }, function () { resolve([]); });
                return;
            }
            if (typeof fsImpl.readdir !== "function") { resolve([]); return; }
            try {
                fsImpl.readdir(fsTarget, function (error, names) { resolve(error || !mediaArray(names) ? [] : names); });
            } catch (error) { resolve([]); }
        });
    }

    function mediaIsDirectory(stats) {
        return !!(stats && typeof stats.isDirectory === "function" && stats.isDirectory());
    }

    function mediaIsFile(stats) {
        if (!stats) return false;
        return typeof stats.isFile !== "function" || stats.isFile();
    }

    // FIX 8a/8b: name the reason a card insertion failed. `invalid-grid` used to
    // be the only clue and it never reached the user, which is why this class of
    // failure was hard to find.
    function mediaInsertionReason(insertion, grid) {
        if (!insertion) return "card-insertion-returned-nothing";
        var reason = insertion.reason ? String(insertion.reason) : "insert-rejected";
        if (reason === "invalid-grid") {
            reason += grid ? " (grid has no appendChild)" : " (no grid resolved for the active section)";
            if (mediaGridResolution && mediaGridResolution.reason) reason += " [" + mediaGridResolution.reason + "]";
        }
        if (mediaArray(insertion.skipped) && insertion.skipped.length > 1) {
            reason += " (" + insertion.skipped.length + " entries skipped)";
        }
        return reason;
    }

    // Flatten whatever a failed import returned into one short human string, so
    // the toast can say WHY instead of "Folder import failed".
    function mediaDescribeImportFailure(result) {
        var parts = [];
        var commit;
        var inner;
        function push(value) {
            if (value === undefined || value === null || value === "") return;
            var text = String(value);
            if (parts.indexOf(text) === -1) parts.push(text);
        }
        if (!result) return "no result";
        push(result.reason);
        commit = result.commit || null;
        if (commit) {
            push(commit.operation);
            push(commit.reason);
            inner = commit.error || null;
            if (inner) push(inner.reason || inner.message || inner);
        }
        if (result.error) push(result.error.message || result.error);
        return parts.length ? parts.join(" — ") : "unknown reason";
    }

    function MediaRefreshCoalescer(options) {
        options = options || {};
        this._categoryRefresh = typeof options.categoryRefresh === "function" ? options.categoryRefresh : function () { };
        this._gridRefresh = typeof options.gridRefresh === "function" ? options.gridRefresh : function () { };
        this._requestFrame = options.requestAnimationFrame || (window && window.requestAnimationFrame);
        this._cancelFrame = options.cancelAnimationFrame || (window && window.cancelAnimationFrame);
        this._setTimer = options.setTimeout || setTimeout;
        this._clearTimer = options.clearTimeout || clearTimeout;
        this.categoryDirty = false;
        this.gridDirty = false;
        this.scheduled = false;
        this._handle = null;
        this._timerOwned = false;
        this._disposed = false;
        this.totals = { category: 0, grid: 0, frames: 0 };
    }

    MediaRefreshCoalescer.prototype.request = function (category, grid) {
        var self = this;
        if (this._disposed) return false;
        if (category) this.categoryDirty = true;
        if (grid) this.gridDirty = true;
        if (this.scheduled || (!this.categoryDirty && !this.gridDirty)) return false;
        this.scheduled = true;
        function flush() { self.flush(); }
        if (typeof this._requestFrame === "function") {
            this._timerOwned = false;
            this._handle = this._requestFrame.call(window, flush);
        } else {
            this._timerOwned = true;
            this._handle = this._setTimer(flush, 16);
        }
        return true;
    };

    MediaRefreshCoalescer.prototype.flush = function () {
        if (this._disposed) return;
        var category = this.categoryDirty;
        var grid = this.gridDirty;
        this.categoryDirty = false;
        this.gridDirty = false;
        this.scheduled = false;
        this._handle = null;
        this.totals.frames++;
        if (category) { this.totals.category++; this._categoryRefresh(); }
        if (grid) { this.totals.grid++; this._gridRefresh(); }
    };

    MediaRefreshCoalescer.prototype.dispose = function () {
        if (this._disposed) return;
        this._disposed = true;
        if (this._handle !== null) {
            if (this._timerOwned) this._clearTimer(this._handle);
            else if (typeof this._cancelFrame === "function") this._cancelFrame.call(window, this._handle);
        }
        this._handle = null;
        this.scheduled = false;
        this.categoryDirty = false;
        this.gridDirty = false;
    };

    function MediaWorkCoordinator(options) {
        if (!(this instanceof MediaWorkCoordinator)) return new MediaWorkCoordinator(options);
        options = options || {};
        this._scheduler = options.scheduler || window.Scheduler || (typeof Scheduler !== "undefined" ? Scheduler : null);
        this._repository = options.repository || null;
        this._cards = options.cardHelper || options.cards || null;
        this._metrics = options.metrics || null;
        this._workers = options.workers || {};
        this._setTimer = options.setTimeout || setTimeout;
        this._clearTimer = options.clearTimeout || clearTimeout;
        this._progressInterval = Number(options.progressIntervalMs);
        if (!(this._progressInterval > 0)) this._progressInterval = 500;
        this._onProgress = typeof options.onProgress === "function" ? options.onProgress : function () { };
        this._onTerminal = typeof options.onTerminal === "function" ? options.onTerminal : function () { };
        this._onIdle = typeof options.onIdle === "function" ? options.onIdle : function () { };
        this._batches = {};
        this._disposed = false;
    }

    MediaWorkCoordinator.prototype._key = function (id) { return "$" + String(id); };

    MediaWorkCoordinator.prototype._observeScheduler = function () {
        if (!this._metrics || !this._scheduler || typeof this._scheduler.snapshot !== "function") return;
        var snapshot;
        try { snapshot = this._scheduler.snapshot(); } catch (ignoreSnapshot) { return; }
        if (!snapshot || !snapshot.lanes) return;
        var names = ["filesystem", "thumbnail", "ffmpeg"];
        for (var i = 0; i < names.length; i++) {
            var lane = snapshot.lanes[names[i]];
            if (lane && typeof this._metrics.observeLane === "function") {
                this._metrics.observeLane(names[i], lane.pending, lane.active);
            }
        }
        if (typeof this._metrics.observeProcessCount === "function") {
            this._metrics.observeProcessCount(Number(snapshot.processes) || 0);
        }
        if (typeof this._metrics.observeChildProcessCount === "function") {
            this._metrics.observeChildProcessCount(Number(snapshot.processes) || 0);
        }
    };

    MediaWorkCoordinator.prototype._finishStageMetric = function (record, stage, mediaId, error, result) {
        if (!record || record.metricSettled || !this._metrics || typeof this._metrics.stageEnd !== "function") return;
        record.metricSettled = true;
        var outcome = error || (result && result.cancelled) ? "failed" :
            (result && result.ok === false ? "derivative-unavailable" : "success");
        this._metrics.stageEnd(stage, mediaId, outcome, error ? String(error) : null);
    };

    MediaWorkCoordinator.prototype._defaultCopy = function (item, control) {
        return asyncMkdir(item.destinationFolder).then(function () {
            return copyFileStream(item.sourcePath, item.destinationMedia, control);
        }).then(function (result) {
            return asyncStat(item.destinationMedia).catch(function () { return null; }).then(function (stats) {
                result.fileSize = stats && Number(stats.size) >= 0 ? Number(stats.size) : 0;
                return result;
            });
        });
    };

    MediaWorkCoordinator.prototype._defaultThumbnail = function (item, control) {
        var decode = item.isVideo ? extractVideoFrame(item.destinationMedia, 0.5, item.destinationThumbnail, control) :
            generateImageThumbnail(item.destinationMedia, item.destinationThumbnail, control);
        return decode.then(function (result) {
            result.status = "available";
            return result;
        }, function (decodeError) {
            // Video has always degraded to drawn placeholder artwork plus the
            // ffmpeg lane. FIX 7 extends the same degradation to the image
            // formats it newly admits (item.allowPlaceholderThumbnail, set from
            // PLACEHOLDER_FALLBACK_IMAGE_EXTENSIONS in _prepare) so a format CEF
            // cannot decode gets a labelled placeholder instead of a blank card.
            // Every other image keeps the historical no-fallback reply.
            if (!item.isVideo && !item.allowPlaceholderThumbnail) {
                return { ok: false, status: "derivative-unavailable", reason: "image-decode-failed", error: decodeError };
            }
            return generateFallbackThumbnail(item.destinationThumbnail, item.fileName, control).then(function (fallback) {
                fallback.status = "available";
                // Only video has an ffmpeg lane to escalate to; an image must
                // not be routed there (see _afterStage, which gates on isVideo).
                if (item.isVideo) fallback.needsFfmpeg = true;
                fallback.decodeError = decodeError;
                return fallback;
            }, function (fallbackError) {
                var unavailable = {
                    ok: false,
                    status: "derivative-unavailable",
                    reason: item.isVideo ? "video-decode-failed" : "image-decode-failed",
                    error: fallbackError
                };
                if (item.isVideo) unavailable.needsFfmpeg = true;
                return unavailable;
            });
        });
    };

    MediaWorkCoordinator.prototype._defaultFfmpeg = function (item, control) {
        return runFfmpegFallback(item.destinationMedia, item.destinationFolder, item.safeName, control);
    };

    MediaWorkCoordinator.prototype._worker = function (stage) {
        if (typeof this._workers[stage] === "function") return this._workers[stage];
        if (stage === "copy") return this._defaultCopy;
        if (stage === "thumbnail") return this._defaultThumbnail;
        return this._defaultFfmpeg;
    };

    MediaWorkCoordinator.prototype._armProgress = function (batch) {
        var self = this;
        if (batch.progressTimer !== null || batch.idle) return;
        batch.progressTimer = this._setTimer(function tick() {
            batch.progressTimer = null;
            if (batch.idle) return;
            self._onProgress(self.snapshot(batch.id));
            self._armProgress(batch);
        }, this._progressInterval);
    };

    MediaWorkCoordinator.prototype._stage = function (batch, item, stage, lane) {
        var self = this;
        var stageRecord = item.stages[stage];
        var token = item.token;
        var worker = this._worker(stage);
        if (!stageRecord || stageRecord.state !== "not-started" || item.terminalState !== "pending") return null;
        stageRecord.state = "queued";
        batch.pendingCount++;
        item.processingState = "pending";
        var handle;
        rememberMediaSchedulerOwner(batch.id);
        try {
            handle = this._scheduler.enqueue(lane, function (control) {
                if (item.token !== token || item.terminalState !== "pending") return { cancelled: true, stale: true };
                if (stageRecord.state === "queued") {
                    stageRecord.state = "active";
                    batch.pendingCount--;
                    batch.inFlightCount++;
                    item.processingState = "in-flight";
                }
                if (!stageRecord.metricStarted && self._metrics && typeof self._metrics.stageStart === "function") {
                    stageRecord.metricStarted = true;
                    self._metrics.stageStart(stage, item.id);
                }
                self._observeScheduler();
                var stageWork = worker.call(self, item, control);
                if (stage === "thumbnail") {
                    // Bug C fix (meta.json): write the self-describing record
                    // while the thumbnail lane still owns the item — every
                    // filesystem effect of an import must stay attributable
                    // to its owning lane (Property 15), and completion runs
                    // outside any lane.
                    return Promise.resolve(stageWork).then(function (thumbnailResult) {
                        self._persistMediaMetaFile(item, self._thumbnailMetaFields(item, thumbnailResult));
                        return thumbnailResult;
                    });
                }
                return stageWork;
            }, {
                owner: batch.id,
                batchId: batch.id,
                stage: stage,
                mediaId: item.id,
                sourcePath: item.sourcePath,
                ffmpegTimeoutMs: FFMPEG_TIMEOUT_MS
            });
        } catch (error) {
            batch.pendingCount--;
            stageRecord.state = "failed";
            stageRecord.error = error;
            this._afterStage(batch, item, stage, token, error, null);
            return null;
        }
        stageRecord.handle = handle;
        Promise.resolve(handle && handle.promise !== undefined ? handle.promise : handle).then(function (result) {
            self._afterStage(batch, item, stage, token, null, result);
        }, function (error) {
            self._afterStage(batch, item, stage, token, error, null);
        });
        this._observeScheduler();
        return handle;
    };

    MediaWorkCoordinator.prototype._afterStage = function (batch, item, stage, token, error, result) {
        var record = item.stages[stage];
        if (!record || item.token !== token || record.settled || item.terminalState !== "pending") return false;
        this._finishStageMetric(record, stage, item.id, error, result);
        this._observeScheduler();
        record.settled = true;
        if (record.state === "active") batch.inFlightCount--;
        else if (record.state === "queued") batch.pendingCount--;
        if (batch.pendingCount < 0) batch.pendingCount = 0;
        if (batch.inFlightCount < 0) batch.inFlightCount = 0;
        if (error || (result && result.cancelled)) {
            record.state = "failed";
            record.error = error || new Error(result.reason || "Media stage cancelled");
        } else {
            record.state = result && result.ok === false ? "derivative-unavailable" : "succeeded";
            record.result = result;
            item.completedResults[stage] = result;
        }
        if (stage === "copy") {
            if (record.state !== "succeeded") this._complete(item, batch, "failed", record.error || result);
            else this._stage(batch, item, "thumbnail", "thumbnail");
        } else if (stage === "thumbnail") {
            if (item.isVideo && result && result.needsFfmpeg) this._stage(batch, item, "ffmpeg", "ffmpeg");
            else this._complete(item, batch, record.state === "succeeded" ? "ready" : "derivative-unavailable", result);
        } else if (stage === "ffmpeg") {
            var priorThumbnail = item.completedResults.thumbnail;
            var usableDerivative = record.state === "succeeded" && result && result.ok &&
                ((priorThumbnail && priorThumbnail.ok) || result.thumbnailPath);
            this._complete(item, batch, usableDerivative ? "ready" : "derivative-unavailable", result);
        }
        this._checkIdle(batch);
        return true;
    };

    MediaWorkCoordinator.prototype._completionFields = function (item, terminal) {
        var copy = item.completedResults.copy || null;
        var thumbnail = item.completedResults.thumbnail || {};
        var ffmpeg = item.completedResults.ffmpeg || {};
        if (ffmpeg.ok && ffmpeg.thumbnailPath) thumbnail = { ok: true, path: ffmpeg.thumbnailPath, status: "available" };
        var fields = {
            thumbStatus: thumbnail.ok && thumbnail.path ? "ready" : "failed",
            terminalState: terminal === "derivative-unavailable" ? "ready" : terminal,
            derivativeStatus: terminal === "derivative-unavailable" ? "derivative-unavailable" : (terminal === "failed" ? "failed" : "available"),
            updatedAt: new Date().toISOString(),
            _isPending: false
        };
        if (copy) {
            fields.mediaFile = item.destinationMedia;
            fields.mainFile = item.fileName;
            fields.fileSize = Number(copy.fileSize) >= 0 ? Number(copy.fileSize) : 0;
        }
        if (thumbnail.ok && thumbnail.path) {
            fields.thumbnail = thumbnail.path;
            fields.thumbnailPath = thumbnail.path;
        }
        if (ffmpeg.ok && ffmpeg.proxyPath) fields.proxyFile = ffmpeg.proxyPath;
        return fields;
    };

    MediaWorkCoordinator.prototype._cardFields = function (item, fields, terminal) {
        var patch = {
            thumbStatus: fields.thumbStatus,
            terminalState: terminal === "failed" ? "failed" : "ready",
            derivativeStatus: fields.derivativeStatus,
            _isPending: false
        };
        if (fields.mediaFile) patch.mediaFile = fields.proxyFile || fields.mediaFile;
        if (fields.thumbnailPath) patch.thumbnailPath = fields.thumbnailPath;
        return patch;
    };

    // Bug C fix: media records are index-only state — a library scan alone
    // could never reconstruct them. Writing the entry's meta.json beside the
    // copied media file makes the folder self-describing, so getAllTemplates
    // re-emits the record on every future scan. Shape mirrors the legacy
    // fallback writer (compatibilityRepository.patchById). Fire-and-forget:
    // a write failure only logs a warning — the index still carries the
    // record, so the import itself remains successful. The write is issued
    // from the thumbnail stage (see _stage) so it executes while the
    // thumbnail lane owns the item.
    MediaWorkCoordinator.prototype._thumbnailMetaFields = function (item, thumbnailResult) {
        var fields = {
            mediaFile: item.destinationMedia,
            mainFile: item.fileName,
            updatedAt: new Date().toISOString()
        };
        var thumb = thumbnailResult && thumbnailResult.path ? thumbnailResult.path : "";
        if (thumb) {
            fields.thumbnail = thumb;
            fields.thumbnailPath = thumb;
        }
        return fields;
    };

    MediaWorkCoordinator.prototype._persistMediaMetaFile = function (item, fields) {
        try {
            if (!item || !item.destinationFolder) return;
            var entry = item.entry || {};
            var meta = {};
            var key;
            for (key in entry) {
                if (mediaOwn(entry, key) && key.charAt(0) !== "_") meta[key] = entry[key];
            }
            for (key in fields) {
                if (mediaOwn(fields, key) && key.charAt(0) !== "_") meta[key] = fields[key];
            }
            meta.schemaVersion = 2;
            meta.id = item.id;
            meta.type = "media";
            meta.section = entry.section || "footage";
            meta.mediaType = entry.mediaType || (item.isVideo ? "video" : "image");
            meta.mimeType = item.isVideo ? "video/mp4" : "image/png";
            meta.sourcePath = entry.sourcePath || item.sourcePath;
            meta.mainFile = fields.mainFile || item.fileName;
            meta.mediaFile = fields.mediaFile || item.destinationMedia;
            meta.thumbnail = fields.thumbnailPath || fields.thumbnail || entry.thumbnail || "";
            meta.thumbnailPath = meta.thumbnail;
            meta.updatedAt = new Date().toISOString();
            var target = path.join(item.destinationFolder, "meta.json");
            Promise.resolve(asyncWriteFile(target, JSON.stringify(meta, null, 4), "utf8")).then(function () { }, function (metaWriteError) {
                if (typeof console !== "undefined" && console && typeof console.warn === "function") {
                    console.warn("[FastMedia] meta.json write failed (non-fatal) for " + item.id + ": " + metaWriteError);
                }
            });
        } catch (metaError) {
            if (typeof console !== "undefined" && console && typeof console.warn === "function") {
                console.warn("[FastMedia] meta.json write skipped (non-fatal) for " + (item && item.id) + ": " + metaError);
            }
        }
    };

    MediaWorkCoordinator.prototype._complete = function (item, batch, desiredTerminal, detail) {
        var self = this;
        if (item.terminalState !== "pending" || item.settling) return false;
        item.settling = true;
        item.processingState = "in-flight";
        item.stages.completion.state = "active";
        batch.inFlightCount++;
        var completionToken = item.token;
        var fields = this._completionFields(item, desiredTerminal);
        var operation;
        try {
            operation = this._repository && typeof this._repository.patchById === "function" ?
                this._repository.patchById(item.id, fields) : { ok: true };
        } catch (error) { operation = { ok: false, error: error }; }
        Promise.resolve(operation).then(function (repositoryResult) {
            if (self._disposed || item.token !== completionToken) return;
            var requestedTerminal = desiredTerminal === "derivative-unavailable" ? "ready" : desiredTerminal;
            var terminal = repositoryResult && repositoryResult.ok === false ? "failed" : requestedTerminal;
            batch.inFlightCount--;
            if (batch.inFlightCount < 0) batch.inFlightCount = 0;
            item.stages.completion.state = terminal === "failed" && desiredTerminal !== "failed" ? "failed" : "succeeded";
            item.stages.completion.result = repositoryResult;
            item.settling = false;
            if (item.terminalState !== "pending") return;
            item.terminalState = terminal;
            item.processingState = terminal;
            item.failure = terminal === "failed" ? (repositoryResult && repositoryResult.error || detail || null) : null;
            batch.terminalCount++;
            if (self._cards && typeof self._cards.patchById === "function") {
                self._cards.patchById(item.id, self._cardFields(item, fields, terminal));
            }
            self._onTerminal(item, terminal, self.snapshot(batch.id));
            self._checkIdle(batch);
        }, function (error) {
            if (self._disposed || item.token !== completionToken) return;
            batch.inFlightCount--;
            if (batch.inFlightCount < 0) batch.inFlightCount = 0;
            item.settling = false;
            item.stages.completion.state = "failed";
            if (item.terminalState === "pending") {
                item.terminalState = "failed";
                item.processingState = "failed";
                item.failure = error;
                batch.terminalCount++;
                if (self._cards && typeof self._cards.patchById === "function") {
                    self._cards.patchById(item.id, self._cardFields(item, fields, "failed"));
                }
                self._onTerminal(item, "failed", self.snapshot(batch.id));
            }
            self._checkIdle(batch);
        });
        return true;
    };

    MediaWorkCoordinator.prototype._checkIdle = function (batch) {
        if (batch.idle || batch.terminalCount !== batch.items.length || batch.pendingCount || batch.inFlightCount) return false;
        batch.idle = true;
        if (batch.progressTimer !== null) {
            this._clearTimer(batch.progressTimer);
            batch.progressTimer = null;
        }
        var snapshot = this.snapshot(batch.id);
        batch.resolve(snapshot);
        this._onIdle(snapshot, batch);
        if (typeof batch.onIdle === "function") batch.onIdle(snapshot, batch);
        return true;
    };

    MediaWorkCoordinator.prototype.submitBatch = function (batch, onIdle) {
        if (this._disposed) return Promise.reject(new Error("MediaWorkCoordinator is disposed"));
        if (!batch || !batch.id || !mediaArray(batch.items)) return Promise.reject(new Error("Invalid media work batch"));
        var resolveBatch;
        var workBatch = {
            id: batch.id,
            items: batch.items,
            pendingCount: 0,
            inFlightCount: 0,
            terminalCount: 0,
            idle: false,
            progressTimer: null,
            onIdle: onIdle,
            promise: null,
            resolve: null
        };
        workBatch.promise = new Promise(function (resolve) { resolveBatch = resolve; });
        workBatch.resolve = resolveBatch;
        this._batches[this._key(batch.id)] = workBatch;
        for (var i = 0; i < workBatch.items.length; i++) {
            var item = workBatch.items[i];
            item.token = Number(item.token) || 1;
            item.terminalState = "pending";
            item.processingState = "pending";
            item.settling = false;
            item.completedResults = item.completedResults || {};
            item.stages = {
                copy: { state: "not-started", settled: false },
                thumbnail: { state: "not-started", settled: false },
                ffmpeg: { state: "not-started", settled: false },
                completion: { state: "not-started", settled: false }
            };
            this._stage(workBatch, item, "copy", "filesystem");
        }
        if (workBatch.items.length) this._armProgress(workBatch);
        this._checkIdle(workBatch);
        return workBatch.promise;
    };

    MediaWorkCoordinator.prototype.cancelBatch = function (batchId, reason) {
        var batch = this._batches[this._key(batchId)];
        if (!batch || batch.idle) return false;
        if (this._scheduler && typeof this._scheduler.cancelByOwner === "function") this._scheduler.cancelByOwner(batch.id, reason || "media batch cancelled");
        batch.pendingCount = 0;
        batch.inFlightCount = 0;
        for (var i = 0; i < batch.items.length; i++) {
            var item = batch.items[i];
            item.token++;
            if (item.terminalState === "pending") {
                var cancellationFields = {
                    terminalState: "failed",
                    thumbStatus: "failed",
                    derivativeStatus: "cancelled",
                    _isPending: false,
                    updatedAt: new Date().toISOString()
                };
                item.terminalState = "failed";
                item.processingState = "failed";
                item.failure = reason || "media batch cancelled";
                item.settling = false;
                batch.terminalCount++;
                if (this._repository && typeof this._repository.patchById === "function") {
                    try {
                        var cancellationCommit = this._repository.patchById(item.id, cancellationFields);
                        if (cancellationCommit && typeof cancellationCommit.then === "function") {
                            cancellationCommit.then(function () { }, function () { });
                        }
                    } catch (ignoreCancellationCommit) { }
                }
                if (this._cards && typeof this._cards.patchById === "function") {
                    this._cards.patchById(item.id, {
                        terminalState: cancellationFields.terminalState,
                        thumbStatus: cancellationFields.thumbStatus,
                        derivativeStatus: cancellationFields.derivativeStatus,
                        _isPending: cancellationFields._isPending
                    });
                }
            }
        }
        this._checkIdle(batch);
        return true;
    };

    MediaWorkCoordinator.prototype.snapshot = function (batchId) {
        var batch = this._batches[this._key(batchId)];
        if (!batch) return null;
        var items = [];
        for (var i = 0; i < batch.items.length; i++) {
            var item = batch.items[i];
            items.push({
                id: item.id,
                sourcePath: item.sourcePath,
                destinationFolder: item.destinationFolder,
                processingState: item.processingState,
                terminalState: item.terminalState,
                completedResults: item.completedResults,
                stages: item.stages
            });
        }
        return {
            id: batch.id,
            pendingCount: batch.pendingCount,
            inFlightCount: batch.inFlightCount,
            terminalCount: batch.terminalCount,
            timerCount: batch.progressTimer === null ? 0 : 1,
            idle: batch.idle,
            items: items
        };
    };

    MediaWorkCoordinator.prototype.dispose = function (reason) {
        if (this._disposed) return false;
        this._disposed = true;
        var keys = Object.keys(this._batches);
        for (var i = 0; i < keys.length; i++) this.cancelBatch(this._batches[keys[i]].id, reason || "media work disposed");
        return true;
    };

    function MediaImportCoordinator(options) {
        if (!(this instanceof MediaImportCoordinator)) return new MediaImportCoordinator(options);
        options = options || {};
        this._fs = options.fs || fs;
        this._repository = options.repository || null;
        this._cards = options.cardHelper || options.cards || null;
        this._metrics = options.metrics || null;
        this._scheduler = options.scheduler || window.Scheduler || (typeof Scheduler !== "undefined" ? Scheduler : null);
        this._grid = options.grid || null;
        this._getGrid = typeof options.getGrid === "function" ? options.getGrid : null;
        this._rootPath = options.rootPath || "";
        this._getRootPath = typeof options.getRootPath === "function" ? options.getRootPath : null;
        this._idFactory = typeof options.idFactory === "function" ? options.idFactory : null;
        this._platform = options.platform || (typeof process !== "undefined" && process.platform ? process.platform : "");
        this._caseInsensitive = options.caseInsensitivePaths === true || this._platform === "win32";
        this._categoryCounts = typeof options.updateCategoryCounts === "function" ? options.updateCategoryCounts : function () { };
        this._reconcileAfterIdle = options.reconcileAfterIdle !== false;
        this._refresh = new MediaRefreshCoalescer(options);
        this._batches = {};
        this._disposed = false;
        this.totals = {
            commits: 0, cardBatches: 0, categoryCountUpdates: 0, accepted: 0, deduplicated: 0,
            // FIX 8b: entries the card helper skipped (already-present ids, or
            // markup that could not be built) instead of failing the batch.
            cardsSkipped: 0,
            // FIX 6: which traversal bound stopped the recursive folder walk.
            // The only diagnostic a caller gets for a truncated discovery.
            discovery: {
                directoriesRead: 0,
                truncatedByDepth: 0,
                truncatedByFileCap: 0,
                truncatedByDirectoryCap: 0
            }
        };
        this._work = options.workCoordinator || new MediaWorkCoordinator({
            scheduler: this._scheduler,
            repository: this._repository,
            cardHelper: this._cards,
            metrics: this._metrics,
            workers: options.workers,
            setTimeout: options.setTimeout,
            clearTimeout: options.clearTimeout,
            progressIntervalMs: options.progressIntervalMs,
            onProgress: options.onProgress,
            onTerminal: options.onTerminal
        });
    }

    MediaImportCoordinator.prototype._batchKey = function (id) { return "$" + String(id); };

    MediaImportCoordinator.prototype._nextId = function (used) {
        var candidate;
        var attempts = 0;
        do {
            mediaCoordinatorSequence++;
            candidate = this._idFactory ? this._idFactory(mediaCoordinatorSequence, attempts) :
                "media-" + new Date().getTime().toString(36) + "-" + mediaSessionNonce + "-" + mediaCoordinatorSequence.toString(36);
            candidate = String(candidate === undefined || candidate === null || candidate === "" ?
                "media-" + mediaSessionNonce + "-" + mediaCoordinatorSequence.toString(36) : candidate);
            if (attempts) candidate += "-" + attempts;
            attempts++;
        } while (mediaOwn(used, "$" + candidate));
        used["$" + candidate] = true;
        return candidate;
    };

    MediaImportCoordinator.prototype._existingIds = function () {
        var used = {};
        var snapshot = this._repository && typeof this._repository.snapshot === "function" ? this._repository.snapshot() : [];
        for (var i = 0; i < snapshot.length; i++) if (snapshot[i] && snapshot[i].id !== undefined) used["$" + String(snapshot[i].id)] = true;
        return used;
    };

    MediaImportCoordinator.prototype._existingSourceIdentities = function () {
        var identities = {};
        var snapshot = this._repository && typeof this._repository.snapshot === "function" ? this._repository.snapshot() : [];
        for (var i = 0; i < snapshot.length; i++) {
            var entry = snapshot[i] || {};
            var sourcePath = entry.sourcePath;
            if (!sourcePath && entry.metadata) sourcePath = entry.metadata.sourcePath;
            if (sourcePath) identities["$" + mediaPathIdentity(sourcePath, this._caseInsensitive)] = true;
        }
        return identities;
    };

    // FIX 6 — folder ingestion used to be exactly ONE level deep: every child
    // was stat'ed and directories were DROPPED (`mediaIsFile(childStats) ?
    // [childPath] : []`), so a folder whose assets live in sub-folders expanded
    // to zero paths and the user was told "No supported media found in folder"
    // about a folder full of media. The walk now descends.
    //
    // Recursion is bounded on four axes (see the MEDIA_DISCOVERY_* constants):
    // depth, files examined, directories read, and concurrent stat() calls. A
    // visited set keyed on the case-folded canonical path means a Windows
    // junction or a POSIX symlink loop cannot hang the panel.
    //
    // Read errors still resolve to [] rather than throwing (mediaAsyncReadDir),
    // which keeps one unreadable sub-folder from failing an otherwise good
    // import. The cost of that choice: a permission-denied folder is
    // INDISTINGUISHABLE from an empty one here — both contribute no paths and no
    // diagnostic. `totals.discovery` below records the caps that were hit, but
    // an EACCES is invisible to it.
    MediaImportCoordinator.prototype._expandCandidate = function (candidate) {
        var self = this;
        var normalized = canonicalizeMediaSourcePath(candidate);
        if (!normalized) return Promise.resolve([]);
        var files = [];
        var visited = {};
        var queue = [];
        var directoriesRead = 0;

        function firstVisit(value) {
            var key = "$" + mediaPathIdentity(value, self._caseInsensitive);
            if (mediaOwn(visited, key)) return false;
            visited[key] = true;
            return true;
        }

        function fileCapReached() {
            if (files.length < MEDIA_DISCOVERY_MAX_FILES) return false;
            self.totals.discovery.truncatedByFileCap++;
            return true;
        }

        function statChild(childPath) {
            return mediaAsyncStat(self._fs, childPath).then(function (childStats) {
                if (!childStats) return null;
                if (mediaIsDirectory(childStats)) return { path: childPath, directory: true };
                return mediaIsFile(childStats) ? { path: childPath, directory: false } : null;
            });
        }

        // One bounded slice of stat() calls at a time. Files are collected here;
        // directories are queued and read later so breadth never exceeds
        // MEDIA_DISCOVERY_STAT_BATCH regardless of how wide the tree is.
        function classify(children, offset, depth) {
            if (offset >= children.length || fileCapReached()) return Promise.resolve();
            var end = offset + MEDIA_DISCOVERY_STAT_BATCH;
            if (end > children.length) end = children.length;
            var checks = [];
            for (var i = offset; i < end; i++) checks.push(statChild(children[i]));
            return Promise.all(checks).then(function (results) {
                for (var r = 0; r < results.length; r++) {
                    var found = results[r];
                    if (!found) continue;
                    if (found.directory) {
                        if (depth + 1 > MEDIA_DISCOVERY_MAX_DEPTH) {
                            self.totals.discovery.truncatedByDepth++;
                            continue;
                        }
                        queue.push({ path: found.path, depth: depth + 1 });
                        continue;
                    }
                    if (fileCapReached()) break;
                    files.push(found.path);
                }
                return classify(children, end, depth);
            });
        }

        function readDirectory(directory, depth) {
            directoriesRead++;
            self.totals.discovery.directoriesRead++;
            return mediaAsyncReadDir(self._fs, directory).then(function (names) {
                var children = [];
                for (var i = 0; i < names.length; i++) {
                    var name = typeof names[i] === "string" ? names[i] : names[i] && names[i].name;
                    if (!name || name === "." || name === "..") continue;
                    children.push(mediaPathJoin(directory, name));
                }
                return classify(children, 0, depth);
            });
        }

        // Level-by-level: read one queued directory, then continue. Keeps the
        // open-handle count at one readdir plus one stat slice.
        function drain() {
            if (!queue.length || fileCapReached()) return Promise.resolve();
            if (directoriesRead >= MEDIA_DISCOVERY_MAX_DIRECTORIES) {
                self.totals.discovery.truncatedByDirectoryCap++;
                return Promise.resolve();
            }
            var next = queue.shift();
            if (!firstVisit(next.path)) return drain();
            return readDirectory(next.path, next.depth).then(drain);
        }

        return mediaAsyncStat(this._fs, normalized).then(function (stats) {
            if (!stats) return [];
            if (!mediaIsDirectory(stats)) return mediaIsFile(stats) ? [normalized] : [];
            firstVisit(normalized);
            return readDirectory(normalized, 0).then(drain).then(function () { return files; });
        });
    };

    MediaImportCoordinator.prototype.discover = function (selection) {
        var list = mediaArray(selection) ? selection.slice() :
            (selection && mediaArray(selection.paths) ? selection.paths.slice() :
                (selection && selection.path ? [selection.path] : (selection ? [selection] : [])));
        var checks = [];
        var self = this;
        for (var i = 0; i < list.length; i++) checks.push(this._expandCandidate(list[i]));
        return Promise.all(checks).then(function (groups) {
            var accepted = [];
            var seen = {};
            var existing = self._existingSourceIdentities();
            for (var g = 0; g < groups.length; g++) {
                for (var j = 0; j < groups[g].length; j++) {
                    var sourcePath = canonicalizeMediaSourcePath(groups[g][j]);
                    var ext = path.extname(sourcePath).toLowerCase();
                    if (!mediaOwn(SUPPORTED_MEDIA_EXTENSIONS, ext)) continue;
                    var identity = "$" + mediaPathIdentity(sourcePath, self._caseInsensitive);
                    if (mediaOwn(seen, identity) || mediaOwn(existing, identity)) { self.totals.deduplicated++; continue; }
                    seen[identity] = true;
                    accepted.push(sourcePath);
                }
            }
            return accepted;
        });
    };

    MediaImportCoordinator.prototype._prepare = function (sourcePaths, options) {
        options = options || {};
        var used = this._existingIds();
        var root = options.rootPath || (this._getRootPath ? this._getRootPath() : this._rootPath) || "";
        var section = options.section || "footage";
        var items = [];
        var entries = [];
        for (var i = 0; i < sourcePaths.length; i++) {
            var sourcePath = sourcePaths[i];
            var ext = path.extname(sourcePath).toLowerCase();
            var fileName = path.basename(sourcePath);
            var baseName = path.basename(sourcePath, ext);
            var category = String(options.category || baseName).substring(0, 30);
            var id = this._nextId(used);
            var destinationFolder = mediaPathJoin(root, section.toLowerCase(), mediaSafeName(category, "Imported"), mediaIdFolderSegment(id));
            // M9: cap the stored filename so deep roots + long names stay
            // within the path budget; dedupe keys derive from sourcePath, so
            // this never changes identity.
            var storedFileName = mediaStorageFileName(fileName, destinationFolder);
            var destinationMedia = mediaPathJoin(destinationFolder, storedFileName);
            var destinationThumbnail = mediaPathJoin(destinationFolder, "thumbnail.png");
            // FIX 7: the optimistic card can only preview the source file
            // directly when CEF can decode it. Pointing <img src> at a .tif or
            // an intrinsic-size-less .svg would render a broken-image glyph
            // until the placeholder lands, so those behave like video here and
            // show the normal empty thumb box instead.
            var previewable = SUPPORTED_MEDIA_EXTENSIONS[ext] === "image" &&
                !mediaOwn(PLACEHOLDER_FALLBACK_IMAGE_EXTENSIONS, ext);
            var entry = {
                id: id,
                name: baseName,
                category: category,
                section: section,
                type: "media",
                mediaType: SUPPORTED_MEDIA_EXTENSIONS[ext],
                folderPath: destinationFolder,
                sourcePath: sourcePath,
                mainFile: storedFileName,
                mediaFile: sourcePath,
                thumbnail: previewable ? sourcePath : "",
                thumbnailPath: previewable ? sourcePath : "",
                thumbStatus: "placeholder",
                favorite: false,
                createdAt: new Date().toISOString(),
                terminalState: "pending",
                derivativeStatus: "pending",
                _isPending: true
            };
            entries.push(entry);
            items.push({
                id: id,
                batchId: "",
                sourcePath: sourcePath,
                destinationFolder: destinationFolder,
                destinationMedia: destinationMedia,
                destinationThumbnail: destinationThumbnail,
                fileName: storedFileName,
                safeName: mediaSafeName(baseName, "Media"),
                extension: ext,
                isVideo: SUPPORTED_MEDIA_EXTENSIONS[ext] === "video",
                // FIX 7: an image format CEF may not decode is allowed to fall
                // back to the drawn placeholder rather than leaving a blank card.
                allowPlaceholderThumbnail: mediaOwn(PLACEHOLDER_FALLBACK_IMAGE_EXTENSIONS, ext),
                entry: entry,
                token: 1
            });
        }
        return { entries: entries, items: items };
    };

    MediaImportCoordinator.prototype._counts = function () {
        var snapshot = this._repository && typeof this._repository.snapshot === "function" ? this._repository.snapshot() : [];
        var counts = {};
        for (var i = 0; i < snapshot.length; i++) {
            var category = snapshot[i] && snapshot[i].category !== undefined ? String(snapshot[i].category) : "";
            counts[category] = (counts[category] || 0) + 1;
        }
        return counts;
    };

    // FIX 8b: narrow a batch down to the entries the card helper actually
    // inserted. A skipped entry has no card, so committing it would publish an
    // index record nothing on screen represents and every later patchById for it
    // would report `missing-registration`. Returns the dropped entries, each
    // annotated with the reason the helper gave, so the caller can surface them.
    //
    // A card helper that reports no `ids` (the stubs in the property suites, and
    // any adapter predating FIX 8b) is treated as "inserted everything", which
    // keeps the pre-fix behaviour for those callers.
    MediaImportCoordinator.prototype._retainInsertedEntries = function (batch, insertion) {
        if (!insertion || !mediaArray(insertion.ids)) return [];
        var reasons = {};
        var skipped = mediaArray(insertion.skipped) ? insertion.skipped : [];
        var keep = {};
        var entries = [];
        var items = [];
        var dropped = [];
        var i;
        for (i = 0; i < skipped.length; i++) {
            if (skipped[i] && skipped[i].id !== undefined && skipped[i].id !== null) {
                reasons["$" + String(skipped[i].id)] = String(skipped[i].reason || "skipped");
            }
        }
        for (i = 0; i < insertion.ids.length; i++) keep["$" + String(insertion.ids[i])] = true;
        for (i = 0; i < batch.entries.length; i++) {
            var entryKey = "$" + String(batch.entries[i].id);
            if (mediaOwn(keep, entryKey)) { entries.push(batch.entries[i]); continue; }
            dropped.push({
                id: batch.entries[i].id,
                sourcePath: batch.entries[i].sourcePath,
                reason: mediaOwn(reasons, entryKey) ? reasons[entryKey] : "not-inserted"
            });
        }
        if (!dropped.length) return dropped;
        for (i = 0; i < batch.items.length; i++) {
            if (mediaOwn(keep, "$" + String(batch.items[i].id))) items.push(batch.items[i]);
        }
        batch.entries = entries;
        batch.items = items;
        batch.pendingCount = items.length;
        this.totals.cardsSkipped += dropped.length;
        return dropped;
    };

    MediaImportCoordinator.prototype._commitFailure = function (batch, result) {
        batch.pendingCount = 0;
        batch.inFlightCount = 0;
        batch.terminalCount = batch.items.length;
        batch.idle = true;
        batch.commitResult = result;
        for (var i = 0; i < batch.items.length; i++) {
            batch.items[i].terminalState = "failed";
            batch.items[i].processingState = "failed";
            if (this._cards && typeof this._cards.patchById === "function") {
                this._cards.patchById(batch.items[i].id, { terminalState: "failed", thumbStatus: "failed", derivativeStatus: "commit-failed", _isPending: false });
            }
        }
        this._refresh.request(false, true);
        return { ok: false, batch: batch, commit: result, accepted: batch.entries.slice() };
    };

    MediaImportCoordinator.prototype.importSelection = function (selection, options) {
        var self = this;
        options = options || {};
        if (this._disposed) return Promise.reject(new Error("MediaImportCoordinator is disposed"));
        return this.discover(selection).then(function (paths) {
            if (self._metrics && typeof self._metrics.recordDiscoveryComplete === "function") self._metrics.recordDiscoveryComplete();
            if (self._disposed || fastMediaDisposed) return { ok: false, cancelled: true, reason: "media import disposed", accepted: [], batch: null };
            if (!paths.length) return { ok: true, empty: true, accepted: [], batch: null };
            var prepared = self._prepare(paths, options);
            var batchId = options.batchId || "media-batch-" + (++mediaCoordinatorSequence);
            var batch = {
                id: String(batchId),
                entries: prepared.entries,
                items: prepared.items,
                pendingCount: prepared.items.length,
                inFlightCount: 0,
                terminalCount: 0,
                idle: false,
                commitResult: null,
                commitCount: 0,
                categoryCountUpdates: 0
            };
            for (var i = 0; i < batch.items.length; i++) batch.items[i].batchId = batch.id;
            self._batches[self._batchKey(batch.id)] = batch;
            var grid = options.grid || (self._getGrid ? self._getGrid(options, batch) : self._grid);
            var insertCards = function () {
                return self._cards && typeof self._cards.insertBatch === "function" ?
                    self._cards.insertBatch(batch.entries, grid) : { ok: false, reason: "card-helper-unavailable" };
            };
            var insertion = self._metrics && typeof self._metrics.phase === "function" ?
                self._metrics.phase("card insertion", insertCards) : insertCards();
            self.totals.cardBatches++;
            // FIX 8b: `insertion.ok === false` still means TOTAL failure — the
            // card helper only answers that way when nothing at all could be
            // inserted or the DOM append itself failed and rolled back. A
            // PARTIAL insert answers ok:true with a `skipped` list, and the
            // import continues with the entries that actually got a card
            // instead of failing all of them.
            if (!insertion || insertion.ok === false) {
                return self._commitFailure(batch, {
                    ok: false,
                    operation: "insertBatch",
                    reason: mediaInsertionReason(insertion, grid),
                    error: insertion
                });
            }
            var skippedEntries = self._retainInsertedEntries(batch, insertion);
            if (batch.entries.length && self._metrics && typeof self._metrics.recordCardVisible === "function") {
                self._metrics.recordCardVisible(batch.entries[0].id);
            }
            self._refresh.request(false, true);
            var commit;
            self.totals.commits++;
            batch.commitCount++;
            try { commit = self._repository.commitOptimisticBatch(batch.entries); }
            catch (error) { commit = { ok: false, operation: "commitOptimisticBatch", error: error }; }
            return Promise.resolve(commit).then(function (commitResult) {
                batch.commitResult = commitResult;
                if (self._disposed || fastMediaDisposed) {
                    batch.pendingCount = 0;
                    batch.inFlightCount = 0;
                    batch.idle = true;
                    return { ok: false, cancelled: true, reason: "media import disposed", accepted: batch.entries.slice(), batch: batch, commit: commitResult };
                }
                if (!commitResult || commitResult.ok === false) return self._commitFailure(batch, commitResult);
                var counts = self._counts();
                batch.categoryCountUpdates++;
                self.totals.categoryCountUpdates++;
                self._categoryCounts(counts, batch.id);
                self._refresh.request(true, false);
                self.totals.accepted += batch.items.length;
                return self._work.submitBatch(batch, function (idleSnapshot) {
                    batch.pendingCount = idleSnapshot.pendingCount;
                    batch.inFlightCount = idleSnapshot.inFlightCount;
                    batch.terminalCount = idleSnapshot.terminalCount;
                    batch.idle = true;
                    self._refresh.request(true, true);
                    if (self._reconcileAfterIdle && self._repository && typeof self._repository.refreshValidityAsync === "function") {
                        Promise.resolve(self._repository.refreshValidityAsync()).then(function () { }, function () { });
                    }
                }).then(function (workSnapshot) {
                    return {
                        ok: true,
                        accepted: batch.entries.slice(),
                        skipped: skippedEntries,
                        batch: batch,
                        work: workSnapshot,
                        commit: commitResult
                    };
                });
            }, function (error) {
                return self._commitFailure(batch, { ok: false, operation: "commitOptimisticBatch", error: error });
            });
        });
    };

    MediaImportCoordinator.prototype.importBatch = MediaImportCoordinator.prototype.importSelection;
    MediaImportCoordinator.prototype.importPaths = MediaImportCoordinator.prototype.importSelection;

    MediaImportCoordinator.prototype.snapshot = function (batchId) {
        var batch = this._batches[this._batchKey(batchId)];
        if (!batch) return null;
        var work = this._work && typeof this._work.snapshot === "function" ? this._work.snapshot(batch.id) : null;
        return {
            id: batch.id,
            acceptedCount: batch.items.length,
            pendingCount: work ? work.pendingCount : batch.pendingCount,
            inFlightCount: work ? work.inFlightCount : batch.inFlightCount,
            terminalCount: work ? work.terminalCount : batch.terminalCount,
            timerCount: (work ? work.timerCount : 0) + (this._refresh.scheduled && this._refresh._timerOwned ? 1 : 0),
            idle: work ? work.idle : batch.idle,
            commitCount: batch.commitCount,
            categoryCountUpdates: batch.categoryCountUpdates,
            refreshTotals: {
                category: this._refresh.totals.category,
                grid: this._refresh.totals.grid,
                frames: this._refresh.totals.frames
            }
        };
    };

    MediaImportCoordinator.prototype.cancelBatch = function (batchId, reason) {
        return this._work && typeof this._work.cancelBatch === "function" ? this._work.cancelBatch(batchId, reason) : false;
    };

    MediaImportCoordinator.prototype.dispose = function () {
        if (this._disposed) return false;
        this._disposed = true;
        if (this._work && typeof this._work.dispose === "function") this._work.dispose("media import disposed");
        this._refresh.dispose();
        return true;
    };

    // =========================================================================
    // PRODUCTION ENTRY-POINT WIRING
    // =========================================================================
    function productionRootPath() {
        return canonicalizeMediaSourcePath(window.rootPath || (typeof rootPath !== "undefined" ? rootPath : ""));
    }

    function productionLibraryPaths() {
        var values = window.libraryPaths || (typeof libraryPaths !== "undefined" ? libraryPaths : null);
        if (mediaArray(values) && values.length) return values.slice();
        var root = productionRootPath();
        return root ? [root] : [];
    }

    function productionGrid(section) {
        var value = String(section || (typeof currentSection !== "undefined" ? currentSection : "footage"));
        var gridId = "comp-list-container";
        if ((typeof SECTIONS !== "undefined" && value === SECTIONS.LAYER) || value === "layer") gridId = "transition-list-container";
        else if ((typeof isTextSection === "function" && isTextSection(value)) || value === "text" || value === "text-props") gridId = "text-list-container";
        else if ((typeof SECTIONS !== "undefined" && value === SECTIONS.FOOTAGE) || value === "footage") gridId = "footage-list-container";
        else if ((typeof SECTIONS !== "undefined" && value === SECTIONS.EFFECT) || value === "effect") gridId = "effect-list-container";
        else if ((typeof isImageSection === "function" && isImageSection(value)) || value === "icon" || value === "image") gridId = "icon-list-container";
        return document.getElementById(gridId);
    }

    function productionCategoryRefresh() {
        if (typeof buildCategoryTabs === "function") buildCategoryTabs();
        if (typeof buildCategoryPanel === "function") buildCategoryPanel();
        if (typeof updateCount === "function") updateCount();
    }

    // Reconcile the windowed grid with the model this engine just changed.
    //
    // This used to be a no-op, on the premise that keyed insertion/patching IS
    // the media grid update. That holds only while nothing else owns the grid's
    // children — and VirtualGrid does: it repaints by replacing them and sizes
    // its scroll spacers from its own id list. So an imported card was appended
    // to the DOM (visible immediately, which is still what we want) but the id
    // list never learned about the record, and the very next scroll wiped the
    // card and laid the grid out for the pre-import list. Imported templates
    // vanished below the fold until a search or category switch rebuilt the ids.
    //
    // The coalescer fires this one frame after the insert, by which time the
    // optimistic commit has published the records into `allTemplates`, so the
    // resync picks them up. If the windowed renderer is not loaded, keyed
    // insertion is still the whole update and there is nothing to reconcile.
    function productionGridRefresh() {
        var sync = typeof syncSectionGridWindow === "function" ? syncSectionGridWindow :
            (window && typeof window.syncSectionGridWindow === "function" ? window.syncSectionGridWindow : null);
        if (!sync) return false;
        try { return sync(); }
        catch (refreshError) { return false; }
    }

    function createProductionMetrics() {
        if (!window.PerfEvents || typeof window.PerfEvents.createMediaScenarioMetrics !== "function") return null;
        return window.PerfEvents.createMediaScenarioMetrics({ enabled: mediaMetricsEnabled() });
    }

    // Production persist for the MediaEntryRepository: funnel every media
    // commit through the SAME staged/verified ladder saveLibraryIndex uses for
    // the shared compSaver_libraryIndex key (stage -> re-read verify ->
    // previous-good promote -> commit -> clear staging).  A raw
    // localStorage.setItem here would let the media writer drift from the
    // template writer and silently clobber verified payloads (Bug A:
    // dual-writer race).  Throws when the ladder cannot commit so the
    // repository reports a failed operation instead of publishing success.
    function productionIndexPersist(serialized) {
        var commit = typeof commitVerifiedLocalStorage === "function" ? commitVerifiedLocalStorage : null;
        var verify = typeof libraryIndexPayloadVerifies === "function" ? libraryIndexPayloadVerifies : null;
        if (!commit || !verify) {
            var missingLadder = [];
            if (!commit) missingLadder.push("commitVerifiedLocalStorage");
            if (!verify) missingLadder.push("libraryIndexPayloadVerifies");
            throw new Error("MediaEntryRepository persist: verified storage ladder unavailable (missing: " +
                missingLadder.join(", ") + ")");
        }
        var committed = commit(
            typeof INDEX_KEY === "string" ? INDEX_KEY : "compSaver_libraryIndex",
            typeof INDEX_STAGING_KEY === "string" ? INDEX_STAGING_KEY : "compSaver_libraryIndex__staging",
            typeof INDEX_PREV_KEY === "string" ? INDEX_PREV_KEY : "compSaver_libraryIndex__prev",
            serialized,
            verify
        );
        if (committed !== true) {
            throw new Error("MediaEntryRepository persist: staged payload failed verification");
        }
    }

    function ensureProductionMediaRuntime() {
        if (productionMediaRuntime || fastMediaDisposed) return productionMediaRuntime;
        var Repository = window.MediaEntryRepository || (typeof MediaEntryRepository !== "undefined" ? MediaEntryRepository : null);
        var Cards = window.KeyedMediaCardHelper || null;
        var scheduler = window.Scheduler || (typeof Scheduler !== "undefined" ? Scheduler : null);
        if (!Repository || !Cards || !scheduler || typeof scheduler.enqueue !== "function") return null;
        var metrics = createProductionMetrics();
        var index = typeof getLibraryIndex === "function" ? getLibraryIndex() : null;
        var repository = new Repository({
            index: index,
            getAllTemplates: function () { return window.allTemplates || (typeof allTemplates !== "undefined" ? allTemplates : []); },
            fs: fs,
            validityPaths: productionLibraryPaths(),
            // Never let the media writer fall back to the raw localStorage
            // setItem default in persistence.js — production commits must go
            // through the staged/verified ladder used by saveLibraryIndex.
            persist: productionIndexPersist
        });
        var cards = new Cards({
            document: document,
            renderCardMarkup: window.renderTemplateCardMarkup || (typeof renderTemplateCardMarkup !== "undefined" ? renderTemplateCardMarkup : null),
            metrics: metrics
        });
        var work = new MediaWorkCoordinator({
            scheduler: scheduler,
            repository: repository,
            cardHelper: cards,
            metrics: metrics
        });
        var coordinator = new MediaImportCoordinator({
            fs: fs,
            scheduler: scheduler,
            repository: repository,
            cardHelper: cards,
            workCoordinator: work,
            metrics: metrics,
            getRootPath: productionRootPath,
            getGrid: function (options) { return productionGrid(options && options.section); },
            updateCategoryCounts: function (counts) {
                if (productionMediaRuntime) productionMediaRuntime.categoryCounts = counts;
            },
            categoryRefresh: productionCategoryRefresh,
            gridRefresh: productionGridRefresh
        });
        productionMediaRuntime = {
            scheduler: scheduler,
            repository: repository,
            cards: cards,
            work: work,
            coordinator: coordinator,
            metrics: metrics,
            categoryCounts: {},
            dispose: function () {
                if (this.coordinator) this.coordinator.dispose();
                if (this.cards) this.cards.dispose();
                if (this.metrics && typeof this.metrics.dispose === "function") this.metrics.dispose();
                this.coordinator = null;
                this.work = null;
                this.cards = null;
                this.metrics = null;
            }
        };
        return productionMediaRuntime;
    }

    function recordProductionMetric(method, value) {
        var runtime = productionMediaRuntime;
        var metrics = runtime && runtime.metrics;
        if (!metrics || typeof metrics[method] !== "function") return null;
        try { return metrics[method](value); } catch (ignoreMetric) { return null; }
    }

    function beginProductionScenario(kind, metadata) {
        var runtime = ensureProductionMediaRuntime();
        productionScenarioToken++;
        activeProductionScenario = productionScenarioToken;
        if (runtime && runtime.metrics && typeof runtime.metrics.start === "function") {
            runtime.metrics.start(kind || "media-import", "production", metadata || {});
        }
        return activeProductionScenario;
    }

    function finishProductionScenario(token, detail) {
        if (!token || token !== activeProductionScenario) return null;
        var runtime = productionMediaRuntime;
        var schedulerSnapshot = runtime && runtime.scheduler && typeof runtime.scheduler.snapshot === "function" ? runtime.scheduler.snapshot() : null;
        var hoverSnapshot = hoverPreviewController && typeof hoverPreviewController.snapshot === "function" ? hoverPreviewController.snapshot() : null;
        var idleSnapshot = {
            childProcesses: schedulerSnapshot ? Number(schedulerSnapshot.processes) || 0 : mediaOwnedChildren.length,
            videoDecoders: hoverSnapshot ? hoverSnapshot.activeDecoderCount : 0,
            result: detail || null
        };
        activeProductionScenario = 0;
        return recordProductionMetric("finishScenario", idleSnapshot);
    }

    function runProductionImport(selection, options, kind, scenarioToken) {
        var runtime = ensureProductionMediaRuntime();
        var token = scenarioToken || beginProductionScenario(kind, { picker: false });
        if (!runtime || !runtime.coordinator) {
            if (typeof showToast === "function") showToast("Media engine unavailable", "error");
            finishProductionScenario(token, { unavailable: true });
            return Promise.resolve({ ok: false, reason: "media-engine-unavailable", accepted: [] });
        }
        if (!productionRootPath()) {
            if (typeof showToast === "function") showToast("Library root not set", "error");
            finishProductionScenario(token, { unavailable: true, reason: "library-root-not-set" });
            return Promise.resolve({ ok: false, reason: "library-root-not-set", accepted: [] });
        }
        options = options || {};
        options.grid = options.grid || productionGrid(options.section);
        return runtime.coordinator.importSelection(selection, options).then(function (result) {
            finishProductionScenario(token, result && result.work ? result.work : result);
            return result;
        }, function (error) {
            finishProductionScenario(token, { error: String(error) });
            if (typeof showToast === "function") showToast("Media import failed", "error");
            return { ok: false, error: error, accepted: [] };
        });
    }

    function importMediaFile(sourcePath, section, forcedCategory, scenarioToken) {
        if (fastMediaDisposed) return Promise.resolve({ ok: false, cancelled: true, accepted: [] });
        return runProductionImport(sourcePath, {
            section: section || "footage",
            category: forcedCategory || null
        }, "single-import", scenarioToken);
    }

    function importMediaFolder(folderPath, section, scenarioToken) {
        if (fastMediaDisposed) return Promise.resolve({ ok: false, cancelled: true, accepted: [] });
        var folderName = path.basename(canonicalizeMediaSourcePath(folderPath));
        if (typeof showToast === "function") showToast("Importing media...", "info");
        return runProductionImport(folderPath, {
            section: section || "footage",
            category: folderName
        }, "folder-import", scenarioToken).then(function (result) {
            if (typeof showToast === "function") {
                if (result && result.ok && result.empty) showToast("No supported media found in folder", "warning");
                else if (result && result.ok) showToast("Folder import complete", "success");
                else if (!result || !result.cancelled) showToast("Folder import failed", "error");
            }
            return result;
        });
    }

    // Historical internal signature retained for the terminal regression harness.
    // Production callers are routed to the same import coordinator as FastMedia.importFile;
    // the isolated fallback also executes through MediaWorkCoordinator rather than the
    // removed per-file completion/rebuild implementation.
    function processBackgroundCopy(meta, sourcePath, safeCat, fileName, isVideo, ext, safeName) {
        if (fastMediaDisposed) return Promise.resolve({ ok: false, cancelled: true, reason: "fast media disposed" });
        var runtime = ensureProductionMediaRuntime();
        if (runtime && runtime.coordinator) {
            return importMediaFile(sourcePath, meta && meta.section, safeCat).then(function (result) {
                var committed = runtime.repository && typeof runtime.repository.getBySourcePath === "function" ?
                    runtime.repository.getBySourcePath(sourcePath) : null;
                if (meta && committed) {
                    for (var key in committed) {
                        if (mediaOwn(committed, key)) meta[key] = committed[key];
                    }
                }
                return result;
            });
        }

        var libRoot = window.rootPath || "";
        if (!libRoot) return Promise.reject(new Error("Library root not set"));
        var categoryDir = path.join(libRoot, String(meta.section || "footage").toLowerCase(), safeCat, safeName).replace(/\\/g, "/");
        var destMedia = path.join(categoryDir, fileName).replace(/\\/g, "/");
        var destThumb = path.join(categoryDir, "thumbnail.png").replace(/\\/g, "/");
        var compatibilityScheduler = {
            enqueue: function (lane, worker) {
                return { promise: Promise.resolve().then(function () { return worker(standaloneControl()); }) };
            },
            cancelByOwner: function () { return true; }
        };
        var compatibilityRepository = {
            patchById: function (id, fields) {
                var finalMeta = {};
                var key;
                for (key in meta) if (mediaOwn(meta, key)) finalMeta[key] = meta[key];
                for (key in fields) if (mediaOwn(fields, key)) finalMeta[key] = fields[key];
                finalMeta.schemaVersion = 2;
                finalMeta.id = id;
                finalMeta.type = "media";
                finalMeta.mainFile = fileName;
                finalMeta.mediaFile = fileName;
                finalMeta.thumbnail = fields.thumbnailPath ? "thumbnail.png" : "";
                finalMeta.thumbnailPath = finalMeta.thumbnail;
                finalMeta.mediaType = isVideo ? "video" : "image";
                finalMeta.mimeType = isVideo ? "video/mp4" : "image/png";
                return asyncWriteFile(path.join(categoryDir, "meta.json"), JSON.stringify(finalMeta, null, 4), "utf8").then(function () {
                    for (var field in fields) if (mediaOwn(fields, field)) meta[field] = fields[field];
                    meta._isPending = false;
                    return { ok: true, snapshot: [finalMeta] };
                });
            }
        };
        var compatibilityWorkers = {
            thumbnail: function (item, control) {
                if (!item.isVideo && fs.promises && typeof fs.promises.copyFile === "function") {
                    return fs.promises.copyFile(item.destinationMedia, item.destinationThumbnail).then(function () {
                        return { ok: true, path: item.destinationThumbnail, status: "available" };
                    });
                }
                return this._defaultThumbnail(item, control);
            }
        };
        var work = new MediaWorkCoordinator({
            scheduler: compatibilityScheduler,
            repository: compatibilityRepository,
            workers: compatibilityWorkers
        });
        var item = {
            id: meta.id,
            batchId: "compatibility-" + meta.id,
            sourcePath: canonicalizeMediaSourcePath(sourcePath),
            destinationFolder: categoryDir,
            destinationMedia: destMedia,
            destinationThumbnail: destThumb,
            fileName: fileName,
            safeName: safeName,
            extension: ext,
            isVideo: !!isVideo,
            entry: meta,
            token: 1
        };
        return work.submitBatch({ id: item.batchId, items: [item] }).then(function (snapshot) {
            return {
                ok: snapshot && snapshot.terminalCount === 1 && snapshot.items[0].terminalState === "ready",
                copy: item.completedResults.copy,
                thumbnail: item.completedResults.thumbnail,
                ffmpeg: item.completedResults.ffmpeg || null,
                metadata: meta
            };
        });
    }

    // =========================================================================
    // PHASE 3: HOVER PREVIEW
    // =========================================================================
    function hoverAttribute(card, names) {
        if (!card || typeof card.getAttribute !== "function") return "";
        for (var i = 0; i < names.length; i++) {
            var value = card.getAttribute(names[i]);
            if (value !== undefined && value !== null && value !== "") return String(value);
        }
        return "";
    }

    function hoverStableId(card) {
        var id = hoverAttribute(card, ["data-media-id", "data-id"]);
        if (!id && card && card.id) id = String(card.id).indexOf("tpl-") === 0 ? String(card.id).substring(4) : String(card.id);
        return id;
    }

    function hoverFindEntry(card) {
        var id = hoverStableId(card);
        var entries = window.allTemplates;
        if (!id || !mediaArray(entries)) return null;
        for (var i = 0; i < entries.length; i++) {
            if (entries[i] && String(entries[i].id) === id) return entries[i];
        }
        return null;
    }

    function hoverPath(value, folder) {
        var result = String(value || "").replace(/\\/g, "/");
        if (!result) return "";
        if (/^file:\/\//i.test(result) || /^[A-Za-z]:\//.test(result) || result.indexOf("//") === 0 || result.charAt(0) === "/") return result;
        return folder ? String(folder).replace(/\\/g, "/").replace(/\/+$/, "") + "/" + result.replace(/^\/+/, "") : result;
    }

    function hoverFilePath(value) {
        var result = String(value || "").replace(/^file:\/\/\//i, "");
        try { result = decodeURI(result); } catch (ignoreDecode) { }
        if (/^\/[A-Za-z]:\//.test(result)) result = result.substring(1);
        return result.replace(/\\/g, "/");
    }

    function hoverMediaUrl(value) {
        var result = String(value || "").replace(/\\/g, "/");
        if (/^file:\/\//i.test(result)) return result;
        if (result.charAt(0) === "/") result = result.substring(1);
        return "file:///" + encodeURI(result);
    }

    function hoverIsMediaLoadingError(error, video) {
        var name = error && error.name ? String(error.name) : "";
        var code = error && error.code !== undefined ? Number(error.code) : 0;
        var message = error && error.message ? String(error.message).toLowerCase() : "";
        if (video && video.error) return true;
        if (name === "NotSupportedError" || code === 3 || code === 4) return true;
        return /codec|decode|media|source|format|not supported/.test(message);
    }

    function hoverHasCardClass(node) {
        if (!node) return false;
        if (node.classList && typeof node.classList.contains === "function") return node.classList.contains("card");
        return /(^|\s)card(\s|$)/.test(String(node.className || ""));
    }

    function hoverCardFromTarget(target) {
        var node = target;
        if (node && typeof node.closest === "function") return node.closest(".card");
        while (node && node !== document) {
            if (hoverHasCardClass(node)) return node;
            node = node.parentNode;
        }
        return null;
    }

    function HoverPreviewController(options) {
        if (!(this instanceof HoverPreviewController)) return new HoverPreviewController(options);
        options = options || {};
        this._document = options.document || document;
        this._scheduler = options.scheduler || window.Scheduler || (typeof Scheduler !== "undefined" ? Scheduler : null);
        this._setTimer = options.setTimeout || setTimeout;
        this._clearTimer = options.clearTimeout || clearTimeout;
        this._createVideo = options.createVideo || null;
        this._resolveMedia = typeof options.resolveMedia === "function" ? options.resolveMedia : null;
        this._proxyWorker = typeof options.proxyWorker === "function" ? options.proxyWorker : null;
        this._metrics = options.metrics || null;
        this._ownMetrics = options.ownMetrics === true;
        this._owner = options.owner || FAST_MEDIA_SCHEDULER_OWNER;
        this._intentDelay = Number(options.intentDelayMs);
        this._activationDelay = Number(options.activationTimeoutMs);
        if (!(this._intentDelay >= 0)) this._intentDelay = HOVER_INTENT_MS;
        if (!(this._activationDelay >= 0)) this._activationDelay = HOVER_ACTIVATION_TIMEOUT_MS;
        this._MutationObserver = options.MutationObserver || window.MutationObserver || null;
        this._video = null;
        this._currentCard = null;
        this._currentInfo = null;
        this._phase = "idle";
        this._token = 0;
        this._intentTimer = null;
        this._activationTimer = null;
        this._listeners = [];
        this._observer = null;
        this._documentListeners = [];
        this._initialized = false;
        this._disposed = false;
        this._stopping = false;
        this._activeDecoderCount = 0;
        this._attemptType = "";
        this._originalTried = false;
        this._proxyRequests = {};
        this._unplayableProxies = {};
    }

    HoverPreviewController.prototype._observeDecoderCount = function (count) {
        if (this._activeDecoderCount === count) return;
        this._activeDecoderCount = count;
        if (this._metrics && typeof this._metrics.observeDecoderCount === "function") {
            try { this._metrics.observeDecoderCount(count); } catch (ignoreMetric) { }
        }
    };

    HoverPreviewController.prototype._listen = function (target, eventName, listener, collection) {
        if (!target || typeof target.addEventListener !== "function") return;
        target.addEventListener(eventName, listener);
        (collection || this._listeners).push({ target: target, eventName: eventName, listener: listener });
    };

    HoverPreviewController.prototype._removeListeners = function (collection) {
        var entries = collection || this._listeners;
        for (var i = 0; i < entries.length; i++) {
            try { entries[i].target.removeEventListener(entries[i].eventName, entries[i].listener); } catch (ignoreListener) { }
        }
        entries.length = 0;
    };

    HoverPreviewController.prototype._isAttached = function (card) {
        if (!card) return false;
        if (typeof card.isConnected === "boolean") return card.isConnected;
        var root = this._document && (this._document.documentElement || this._document.body);
        if (root && typeof root.contains === "function") return root.contains(card);
        return true;
    };

    HoverPreviewController.prototype._mediaInfo = function (card, overridePath) {
        var custom = this._resolveMedia ? this._resolveMedia(card) : null;
        var entry = hoverFindEntry(card);
        var folder = hoverAttribute(card, ["data-folder"]) || (entry && entry.folderPath) || "";
        var current = overridePath || hoverAttribute(card, ["data-mediapath"]);
        var proxy = hoverAttribute(card, ["data-proxypath", "data-proxy-path", "data-proxyfile", "data-proxy-file"]);
        var original = hoverAttribute(card, ["data-originalpath", "data-original-path", "data-mediafile", "data-media-file", "data-sourcepath", "data-source-path"]);
        if (custom) {
            folder = custom.folderPath || custom.folder || folder;
            proxy = custom.proxyPath || custom.proxyFile || proxy;
            original = custom.originalPath || custom.mediaPath || custom.mediaFile || custom.sourcePath || original;
            current = custom.currentPath || current;
        }
        if (entry) {
            proxy = proxy || entry.proxyFile || "";
            original = original || entry.mediaFile || entry.sourcePath || "";
        }
        proxy = hoverPath(proxy, folder);
        original = hoverPath(original, folder);
        current = hoverPath(current, folder);
        if (!original && (!proxy || current !== proxy)) original = current;
        if (!proxy && entry && entry.proxyFile) proxy = hoverPath(entry.proxyFile, folder);
        return {
            id: hoverStableId(card),
            card: card,
            folderPath: folder,
            proxyPath: proxy,
            originalPath: original,
            safeName: hoverAttribute(card, ["data-file"]) || (entry && entry.name) || "Media"
        };
    };

    HoverPreviewController.prototype._ensureVideo = function () {
        if (this._video) return this._video;
        this._video = this._createVideo ? this._createVideo() : this._document.createElement("video");
        this._video.className = "media-vid fade-in";
        this._video.muted = true;
        this._video.loop = true;
        this._video.playsInline = true;
        this._video.autoplay = false;
        try { this._video.setAttribute("muted", "muted"); } catch (ignoreMuted) { }
        try { this._video.setAttribute("playsinline", "playsinline"); } catch (ignoreInline) { }
        return this._video;
    };

    HoverPreviewController.prototype._clearIntent = function () {
        if (this._intentTimer !== null) this._clearTimer(this._intentTimer);
        this._intentTimer = null;
    };

    HoverPreviewController.prototype._clearActivation = function () {
        if (this._activationTimer !== null) this._clearTimer(this._activationTimer);
        this._activationTimer = null;
    };

    HoverPreviewController.prototype._releaseVideo = function (destroy) {
        var video = this._video;
        this._removeListeners(this._listeners);
        if (video) {
            try { if (typeof video.pause === "function") video.pause(); } catch (ignorePause) { }
            try { if (typeof video.removeAttribute === "function") video.removeAttribute("src"); } catch (ignoreSource) { }
            try { video.src = ""; } catch (ignoreEmptySource) { }
            try { if (typeof video.load === "function") video.load(); } catch (ignoreLoad) { }
            try { if (video.parentNode) video.parentNode.removeChild(video); } catch (ignoreDetach) { }
        }
        this._attemptType = "";
        this._observeDecoderCount(0);
        if (destroy) this._video = null;
    };

    HoverPreviewController.prototype._queueProxy = function (info) {
        var self = this;
        var id = info && info.id ? String(info.id) : "";
        var original = info && info.originalPath ? hoverFilePath(info.originalPath) : "";
        var key = "$" + id;
        var record;
        if (!id || !original || !info.folderPath || !this._scheduler || typeof this._scheduler.enqueue !== "function") return null;
        if (mediaOwn(this._proxyRequests, key)) return this._proxyRequests[key].handle;
        record = { handle: null, state: "queued" };
        this._proxyRequests[key] = record;
        rememberMediaSchedulerOwner(this._owner);
        try {
            record.handle = this._scheduler.enqueue("ffmpeg", function (control) {
                record.state = "active";
                if (self._disposed) return { cancelled: true, reason: "hover controller disposed" };
                if (self._proxyWorker) return self._proxyWorker(info, control);
                return runFfmpegFallback(original, info.folderPath, info.safeName, control);
            }, {
                owner: this._owner,
                stage: "ffmpeg-proxy",
                mediaId: id,
                sourcePath: original,
                ffmpegTimeoutMs: FFMPEG_TIMEOUT_MS
            });
            Promise.resolve(record.handle.promise).then(function () { record.state = "settled"; }, function () { record.state = "settled"; });
        } catch (error) {
            record.state = "failed";
            record.error = error;
        }
        return record.handle;
    };

    HoverPreviewController.prototype._onOriginalError = function (token) {
        var info = this._currentInfo;
        if (token !== this._token || this._disposed || !info) return;
        this._queueProxy(info);
        this.stop("original-error");
    };

    HoverPreviewController.prototype._startAttempt = function (kind, mediaPath, token) {
        var self = this;
        var card = this._currentCard;
        var thumbBox;
        var video;
        var playResult;
        if (token !== this._token || this._disposed) return false;
        if (!this._isAttached(card)) { this.stop("card-detached"); return false; }
        thumbBox = card && typeof card.querySelector === "function" ? card.querySelector(".thumb-box") : null;
        if (!thumbBox || !mediaPath) { this.stop("preview-target-unavailable"); return false; }
        this._releaseVideo(false);
        if (token !== this._token || this._disposed) return false;
        video = this._ensureVideo();
        this._attemptType = kind;
        if (kind === "original") this._originalTried = true;
        this._phase = "loading";
        this._listen(video, "playing", function () {
            if (token !== self._token || self._disposed || !self._isAttached(card)) {
                if (token === self._token && !self._disposed) self.stop("card-detached");
                return;
            }
            self._phase = "playing";
            self._clearActivation();
        });
        this._listen(video, "error", function () {
            if (token !== self._token || self._disposed || card !== self._currentCard) return;
            if (kind === "proxy" && !self._originalTried && self._currentInfo && self._currentInfo.originalPath) {
                self._unplayableProxies["$" + self._currentInfo.id] = true;
                self._startAttempt("original", self._currentInfo.originalPath, token);
                return;
            }
            if (kind === "original") self._onOriginalError(token);
            else self.stop("proxy-error");
        });
        try {
            video.src = hoverMediaUrl(mediaPath);
            if (video.parentNode !== thumbBox) {
                if (video.parentNode) video.parentNode.removeChild(video);
                thumbBox.appendChild(video);
            }
            this._observeDecoderCount(1);
            if (typeof video.load === "function") video.load();
            playResult = typeof video.play === "function" ? video.play() : null;
            if (playResult && typeof playResult.then === "function") {
                playResult.then(function () {
                    if (token !== self._token || self._disposed || card !== self._currentCard) return;
                    if (!self._isAttached(card)) { self.stop("card-detached"); return; }
                    self._phase = "playing";
                    self._clearActivation();
                }, function (playError) {
                    if (token !== self._token || self._disposed || card !== self._currentCard) return;
                    if (hoverIsMediaLoadingError(playError, video)) {
                        if (kind === "proxy" && !self._originalTried && self._currentInfo && self._currentInfo.originalPath) {
                            self._unplayableProxies["$" + self._currentInfo.id] = true;
                            self._startAttempt("original", self._currentInfo.originalPath, token);
                            return;
                        }
                        if (kind === "original") { self._onOriginalError(token); return; }
                    }
                    self.stop("play-rejected");
                });
            }
        } catch (error) {
            if (token === this._token && !this._disposed) {
                if (hoverIsMediaLoadingError(error, video)) {
                    if (kind === "proxy" && !this._originalTried && this._currentInfo && this._currentInfo.originalPath) {
                        this._unplayableProxies["$" + this._currentInfo.id] = true;
                        this._startAttempt("original", this._currentInfo.originalPath, token);
                    } else if (kind === "original") this._onOriginalError(token);
                    else this.stop("preview-error");
                } else this.stop("preview-error");
            }
            return false;
        }
        return true;
    };

    HoverPreviewController.prototype._activate = function (token, overridePath) {
        var self = this;
        var info;
        var proxyKey;
        if (token !== this._token || this._disposed) return false;
        this._intentTimer = null;
        if (!this._isAttached(this._currentCard)) { this.stop("card-detached"); return false; }
        info = this._mediaInfo(this._currentCard, overridePath);
        this._currentInfo = info;
        proxyKey = "$" + info.id;
        this._originalTried = false;
        this._clearActivation();
        this._activationTimer = this._setTimer(function () {
            if (token !== self._token || self._disposed) return;
            self.stop("activation-timeout");
        }, this._activationDelay);
        if (info.proxyPath && !mediaOwn(this._unplayableProxies, proxyKey)) return this._startAttempt("proxy", info.proxyPath, token);
        return this._startAttempt("original", info.originalPath, token);
    };

    HoverPreviewController.prototype.request = function (card, overridePath) {
        var self = this;
        if (this._disposed || !card || !this._isAttached(card)) return false;
        if (card === this._currentCard && this._phase !== "idle") return true;
        this.stop("superseded");
        if (this._disposed) return false;
        this._currentCard = card;
        this._currentInfo = null;
        this._phase = "intent";
        var token = this._token;
        this._intentTimer = this._setTimer(function () { self._activate(token, overridePath); }, this._intentDelay);
        return true;
    };

    HoverPreviewController.prototype.stop = function () {
        this._token++;
        this._stopping = true;
        this._phase = "stopping";
        this._clearIntent();
        this._clearActivation();
        this._releaseVideo(false);
        this._currentCard = null;
        this._currentInfo = null;
        this._originalTried = false;
        this._phase = "idle";
        this._stopping = false;
        return true;
    };

    HoverPreviewController.prototype._handleRemovedNode = function (target) {
        if (this._stopping || !this._currentCard || !target) return;
        if (target === this._currentCard || (typeof target.contains === "function" && target.contains(this._currentCard))) {
            this.stop("card-detached");
        }
    };

    HoverPreviewController.prototype.init = function () {
        var self = this;
        var root;
        if (this._disposed || this._initialized) return false;
        function onMouseOver(event) {
            var card = hoverCardFromTarget(event.target);
            if (!card || (event.relatedTarget && typeof card.contains === "function" && card.contains(event.relatedTarget))) return;
            if (hoverAttribute(card, ["data-type"]) !== "media" || hoverAttribute(card, ["data-mediatype"]) !== "video") return;
            self.request(card);
        }
        function onMouseOut(event) {
            var card = hoverCardFromTarget(event.target);
            if (!card || (event.relatedTarget && typeof card.contains === "function" && card.contains(event.relatedTarget))) return;
            if (card === self._currentCard) self.stop("pointer-leave");
        }
        this._listen(this._document, "mouseover", onMouseOver, this._documentListeners);
        this._listen(this._document, "mouseout", onMouseOut, this._documentListeners);
        root = this._document && (this._document.body || this._document.documentElement);
        if (this._MutationObserver && root) {
            try {
                this._observer = new this._MutationObserver(function () {
                    if (self._currentCard && !self._isAttached(self._currentCard)) self.stop("card-detached");
                });
                this._observer.observe(root, { childList: true, subtree: true });
            } catch (ignoreObserver) { this._observer = null; }
        }
        if (!this._observer) {
            this._listen(this._document, "DOMNodeRemoved", function (event) {
                self._handleRemovedNode(event.target);
            }, this._documentListeners);
        }
        this._initialized = true;
        return true;
    };

    HoverPreviewController.prototype.dispose = function () {
        if (this._disposed) return false;
        this._disposed = true;
        this.stop("disposed");
        this._removeListeners(this._documentListeners);
        if (this._observer && typeof this._observer.disconnect === "function") {
            try { this._observer.disconnect(); } catch (ignoreDisconnect) { }
        }
        this._observer = null;
        this._initialized = false;
        this._releaseVideo(true);
        if (this._ownMetrics && this._metrics && typeof this._metrics.dispose === "function") {
            try { this._metrics.dispose(); } catch (ignoreMetricsDispose) { }
        }
        this._metrics = null;
        return true;
    };

    HoverPreviewController.prototype.snapshot = function () {
        var proxyKeys = Object.keys(this._proxyRequests);
        return {
            token: this._token,
            phase: this._phase,
            cardId: this._currentCard ? hoverStableId(this._currentCard) : "",
            intentTimerCount: this._intentTimer === null ? 0 : 1,
            activationTimerCount: this._activationTimer === null ? 0 : 1,
            listenerCount: this._listeners.length,
            documentListenerCount: this._documentListeners.length,
            activeDecoderCount: this._activeDecoderCount,
            ownsVideo: !!this._video,
            attachedVideoCount: this._video && this._video.parentNode ? 1 : 0,
            proxyRequestCount: proxyKeys.length,
            disposed: this._disposed
        };
    };

    function createHoverPreviewController(options) {
        return new HoverPreviewController(options);
    }

    function runProductionHoverProxy(info, control) {
        var runtime = productionMediaRuntime || ensureProductionMediaRuntime();
        var original = info && info.originalPath ? hoverFilePath(info.originalPath) : "";
        if (!runtime || !runtime.repository || !info || !info.id || !original || !info.folderPath) {
            return Promise.resolve({ ok: false, status: "derivative-unavailable", reason: "media-runtime-unavailable" });
        }
        return runFfmpegFallback(original, info.folderPath, info.safeName || "Media", control).then(function (result) {
            if (!result || !result.ok || !result.proxyPath) return result;
            var fields = {
                proxyFile: result.proxyPath,
                derivativeStatus: "available",
                updatedAt: new Date().toISOString()
            };
            var commit;
            try { commit = runtime.repository.patchById(info.id, fields); }
            catch (error) { commit = { ok: false, error: error }; }
            return Promise.resolve(commit).then(function (commitResult) {
                if (commitResult && commitResult.ok !== false && runtime.cards && typeof runtime.cards.patchById === "function") {
                    runtime.cards.patchById(info.id, { proxyFile: result.proxyPath, derivativeStatus: "available" });
                }
                return result;
            }, function () { return result; });
        });
    }

    function getHoverPreviewController() {
        if (!hoverPreviewController && !fastMediaDisposed) {
            var runtime = ensureProductionMediaRuntime();
            hoverPreviewController = rememberMediaDisposable(new HoverPreviewController({
                scheduler: runtime ? runtime.scheduler : (window.Scheduler || null),
                metrics: runtime ? runtime.metrics : null,
                owner: FAST_MEDIA_SCHEDULER_OWNER,
                resolveMedia: function (card) {
                    var id = hoverStableId(card);
                    return runtime && runtime.repository && typeof runtime.repository.getById === "function" ?
                        runtime.repository.getById(id) : null;
                },
                proxyWorker: runProductionHoverProxy
            }));
        }
        return hoverPreviewController;
    }

    function initHoverPreviews() {
        var controller = getHoverPreviewController();
        if (!controller) return false;
        controller.init();
        initHoverPreviews._dispose = function () {
            if (hoverPreviewController) hoverPreviewController.dispose();
            initHoverPreviews._dispose = null;
        };
        return true;
    }

    function playHoverPreview(card, mediaPath) {
        var controller = getHoverPreviewController();
        return controller ? controller.request(card, mediaPath) : false;
    }

    function stopHoverPreview(card) {
        var controller = hoverPreviewController;
        if (!controller || (card && controller._currentCard && card !== controller._currentCard)) return false;
        return controller.stop("pointer-leave");
    }

    function disposeFastMedia() {
        var disposables;
        var resources;
        if (fastMediaDisposed) return false;
        fastMediaDisposed = true;
        fastMediaGeneration++;
        if (initFastMediaEngine._dispose) initFastMediaEngine._dispose();
        if (hoverPreviewController) hoverPreviewController.dispose();
        initHoverPreviews._dispose = null;
        finishProductionScenario(activeProductionScenario, { disposed: true });
        if (productionMediaRuntime) productionMediaRuntime.dispose();
        productionMediaRuntime = null;
        disposables = mediaOwnedDisposables.slice();
        mediaOwnedDisposables = [];
        for (var i = 0; i < disposables.length; i++) {
            try { disposables[i].dispose(); } catch (ignoreDispose) { }
        }
        cancelMediaSchedulerWork("fast media disposed");
        resources = unfinishedThumbnailResources.slice();
        unfinishedThumbnailResources = [];
        for (var j = 0; j < resources.length; j++) cleanupThumbnailResources(resources[j]);
        stopOwnedChildren();
        hoverPreviewController = null;
        return true;
    }

    function createOwnedImportCoordinator(options) {
        var coordinator = rememberMediaDisposable(new MediaImportCoordinator(options));
        if (options) {
            rememberMediaDisposable(options.cardHelper || options.cards);
            rememberMediaDisposable(options.metrics);
        }
        return coordinator;
    }

    function createOwnedWorkCoordinator(options) {
        var coordinator = rememberMediaDisposable(new MediaWorkCoordinator(options));
        if (options) {
            rememberMediaDisposable(options.cardHelper || options.cards);
            rememberMediaDisposable(options.metrics);
        }
        return coordinator;
    }

    function createOwnedHoverController(options) {
        var controller = rememberMediaDisposable(new HoverPreviewController(options));
        if (options && options.ownMetrics === true) rememberMediaDisposable(options.metrics);
        return controller;
    }

    window.HoverPreviewController = HoverPreviewController;
    window.MediaImportCoordinator = MediaImportCoordinator;
    window.MediaWorkCoordinator = MediaWorkCoordinator;
    window.FastMedia = {
        init: initFastMediaEngine,
        dispose: disposeFastMedia,
        importFile: importMediaFile,
        importFolder: importMediaFolder,
        fitThumbnailDimensions: fitThumbnailDimensions,
        HoverPreviewController: HoverPreviewController,
        MediaImportCoordinator: MediaImportCoordinator,
        MediaWorkCoordinator: MediaWorkCoordinator,
        createHoverPreviewController: createOwnedHoverController,
        createImportCoordinator: createOwnedImportCoordinator,
        createWorkCoordinator: createOwnedWorkCoordinator,
        registerOwnedResource: rememberMediaDisposable,
        canonicalizeSourcePath: canonicalizeMediaSourcePath
    };

})(window, document);
