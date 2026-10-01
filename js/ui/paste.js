// ============================================================
// ui/paste.js - clipboard image paste -> AE import
// ------------------------------------------------------------
// Handles Ctrl+V of image files/blobs (Explorer copy or screenshot)
// and the Paste Image button, then imports through JSX.
//
// Lifecycle guarantees (toolkit quality wave):
//   - initClipboardPaste() is idempotent (single named handler)
//   - ONE paste operation in flight at a time; extra pastes get a
//     friendly toast instead of a duplicate AE import
//   - temp write is ASYNCHRONOUS on the Node path (never blocks the
//     CEP UI thread); the CEP-fs fallback builds base64 in chunks
//     instead of byte-by-byte string concatenation
//   - collision-safe temp names (timestamp + per-panel sequence)
//   - temp file is removed on success, host error, and timeout
//   - the bridge call is bounded by ToolBridge (timeout + late
//     callback suppression + structured result)
//   - text paste is untouched: preventDefault() runs only after an
//     image has actually been accepted
// Depends on globals: DOM, showToast, csInterface,
// encodeBridge/decodeBridge, ToolBridge. initClipboardPaste() is
// called from init(). Loaded before main.js.
// ============================================================

var PasteController = (function () {
    var inFlight = false;        // single-flight: one accepted paste at a time
    var seq = 0;                 // collision-safe suffix within one panel session
    var initialized = false;

    function isImageExtension(name) {
        if (!name) return false;
        var ext = name.split(".").pop().toLowerCase();
        return ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp" || ext === "bmp";
    }

    function getSafeRequire() {
        if (typeof require !== "undefined") return require;
        if (typeof window !== "undefined" && typeof window.require !== "undefined") return window.require;
        return null;
    }

    function makeTempName() {
        return "compsaver_paste_" + Date.now() + "_" + (++seq) + ".png";
    }

    function removeTempQuiet(fs, tempPath) {
        try { fs.unlink(tempPath, function () { }); } catch (e) { /* best effort */ }
    }

    // Import via the host; terminal point of every accepted paste.
    // Cleans the temp file on EVERY terminal path and always releases
    // the single-flight latch (success, host error, timeout).
    function importBounded(fs, tempPath) {
        var cleanPath = tempPath.replace(/\\/g, "/");
        ToolBridge.call({
            key: "paste.import",
            script: 'toolkitImportPastedImage("' + encodeBridge(cleanPath) + '")',
            timeoutMs: 60000,
            onResult: function (result) {
                if (fs) removeTempQuiet(fs, tempPath);
                releasePaste();
                if (result.status !== "success") return; // timeout/host error already toasted

                if (result.decoded.indexOf("OK:") === 0) {
                    showToast(result.decoded.substring(3), "success");
                } else {
                    showToast(result.decoded, "error");
                }
            }
        });
    }

    function acceptPaste() {
        if (inFlight) {
            showToast("A paste is already in progress — please wait", "info");
            return false;
        }
        inFlight = true;
        return true;
    }

    function releasePaste() {
        inFlight = false;
    }

    function handlePasteFile(file) {
        if (file.path) {
            if (!acceptPaste()) return;
            // Existing file on disk: nothing to write or clean up.
            importBounded(null, file.path);
            return;
        }
        handlePasteBlob(file);
    }

    function handlePasteBlob(blob) {
        if (!acceptPaste()) return;

        var reader = new FileReader();
        reader.onload = function () {
            try {
                var req = getSafeRequire();
                if (req) {
                    var buffer = Buffer.from(new Uint8Array(reader.result));
                    var fs = req("fs");
                    var path = req("path");
                    var os = req("os");
                    var tempPath = path.join(os.tmpdir(), makeTempName());
                    // Asynchronous write: a 4K/8K screenshot must never block
                    // the CEP UI thread (the old writeFileSync did).
                    fs.writeFile(tempPath, buffer, function (err) {
                        if (err) {
                            releasePaste();
                            showToast("Paste Error: could not write temp file — " + err.message, "error");
                            return;
                        }
                        importBounded(fs, tempPath);
                    });
                    // inFlight is released when the bounded import finishes.
                } else if (window.cep && window.cep.fs) {
                    var base64Data = chunkedBase64(new Uint8Array(reader.result));
                    var userDataPath = csInterface.getSystemPath(SystemPath.USER_DATA);
                    var tempPath2 = userDataPath + "/" + makeTempName();

                    var writeResult = window.cep.fs.writeFile(tempPath2, base64Data, window.cep.encoding.base64);
                    if (writeResult.err === 0) {
                        importBounded(null, tempPath2);
                    } else {
                        releasePaste();
                        showToast("Paste Error: failed to write file via CEP", "error");
                    }
                } else {
                    releasePaste();
                    showToast("Paste Error: Node.js and CEP FS both unavailable!", "error");
                }
            } catch (err) {
                releasePaste();
                showToast("Paste Error: " + err.message, "error");
            }
        };
        reader.onerror = function () {
            releasePaste();
            showToast("Paste Error: could not read clipboard image", "error");
        };
        reader.readAsArrayBuffer(blob);
    }

    // Build base64 in 8KB chunks. The previous per-byte string += was
    // quadratic on old CEP Chromium and janked multi-MB screenshots.
    function chunkedBase64(bytes) {
        var CHUNK = 0x8000;
        var parts = [];
        for (var i = 0; i < bytes.length; i += CHUNK) {
            var end = Math.min(i + CHUNK, bytes.length);
            parts.push(String.fromCharCode.apply(null, bytes.subarray(i, end)));
        }
        return window.btoa(parts.join(""));
    }

    // Host-side clipboard grab (compiles a helper exe on first run — can
    // take seconds). Bounded + single-flight through ToolBridge so a
    // double-click cannot fire two concurrent clipboard programs.
    function handleImagePaste(button) {
        ToolBridge.call({
            key: "paste.clipboard",
            script: "toolkitImportClipboardImage()",
            button: button || null,
            timeoutMs: 120000,
            onResult: function (result) {
                if (result.status !== "success") return;
                if (result.decoded.indexOf("OK:") === 0) {
                    showToast(result.decoded.substring(3), "success");
                } else {
                    showToast(result.decoded, "error");
                }
            }
        });
    }

    function onWindowPaste(e) {
        var clipboardData = e.clipboardData || window.clipboardData;
        if (!clipboardData) return;

        var items = clipboardData.items;
        var files = clipboardData.files;

        // 1. Copied files (e.g. from Explorer)
        if (files && files.length > 0) {
            for (var i = 0; i < files.length; i++) {
                var file = files[i];
                if (file.type.indexOf("image") !== -1 || isImageExtension(file.name)) {
                    if (e && e.preventDefault) e.preventDefault();
                    handlePasteFile(file);
                    return;
                }
            }
        }

        // 2. Raw image data (screenshot, snippet)
        if (items) {
            for (var j = 0; j < items.length; j++) {
                if (items[j].type.indexOf("image") !== -1) {
                    var blob = items[j].getAsFile();
                    if (blob) {
                        if (e && e.preventDefault) e.preventDefault();
                        handlePasteBlob(blob);
                        return;
                    }
                }
            }
        }
        // No image accepted: leave the event untouched so normal text
        // paste keeps working.
    }

    function init() {
        if (initialized) return;
        initialized = true;
        window.addEventListener("paste", onWindowPaste);
    }

    return {
        init: init,
        handleImagePaste: handleImagePaste,
        handlePasteBlob: handlePasteBlob,
        handlePasteFile: handlePasteFile
    };
})();

function initClipboardPaste() {
    PasteController.init();
}
