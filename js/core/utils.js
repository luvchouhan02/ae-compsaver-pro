// ============================================================
// core/utils.js — pure, dependency-free helpers
// ------------------------------------------------------------
// Section-name normalization and HTML/attribute escaping. No DOM,
// no app state. Depends only on the constants (SECTIONS /
// IMAGE_SECTIONS) from core/constants.js.
// Filesystem-safe naming lives in core/pathBuilders.js, which
// index.html loads immediately before this file.
// Loaded before main.js; resolves as globals via the scope chain.
// ============================================================

function normalizeSectionName(section) {
    if (!section) return "";
    if (section === "transition") return SECTIONS.LAYER;
    if (section === "png") return SECTIONS.ICON;
    if (section === "textprops" || section === "text-properties" || section === "text_properties") {
        return SECTIONS.TEXT_PROPS;
    }
    return section;
}

// getSafeName / generateTemplateId deliberately do NOT live here. The single
// canonical panel definition is js/core/pathBuilders.js (loaded immediately
// before this file in index.html), which is also the implementation the property
// tests exercise. Defining a second rule set here would make the folder-name
// rules depend on script order — the defect R4/F5 removes.

function getTemplateSection(t) {
    if (!t) return "";
    return normalizeSectionName(t.section || t.type || "");
}

function isImageSection(section) {
    return IMAGE_SECTIONS.indexOf(section) !== -1;
}

function isTextSection(section) {
    return section === SECTIONS.TEXT || section === SECTIONS.TEXT_PROPS;
}

function escapeHTML(str) {
    if (!str) return "";
    return ("" + str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function escapeAttr(str) {
    if (!str) return "";
    return ("" + str)
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// ============================================================
// FFmpeg Resolver
// ============================================================
var _ffmpegPathCache = null;
function resolveFfmpeg(cb) {
    if (_ffmpegPathCache !== null) { cb(_ffmpegPathCache); return; }
    if (typeof require === "undefined") { _ffmpegPathCache = ""; cb(""); return; }

    var cp = require("child_process");
    var fs = require("fs");

    function checkBundled() {
        var extPath = typeof csInterface !== "undefined" ? csInterface.getSystemPath(SystemPath.EXTENSION) : "";
        if (!extPath) { _ffmpegPathCache = ""; cb(""); return; }
        var binDir = extPath.replace(/\\/g, "/").replace(/\/+$/, "") + "/bin";
        var candidates = [binDir + "/ffmpeg.exe", binDir + "/ffmpeg"];
        for (var i = 0; i < candidates.length; i++) {
            try {
                if (fs.statSync(candidates[i]).isFile()) {
                    _ffmpegPathCache = candidates[i];
                    cb(candidates[i]);
                    return;
                }
            } catch (e) { }
        }
        _ffmpegPathCache = "";
        cb("");
    }

    try {
        cp.execFile("ffmpeg", ["-version"], { timeout: 2000 }, function (err) {
            if (!err) {
                _ffmpegPathCache = "ffmpeg";
                cb("ffmpeg");
                return;
            }
            checkBundled();
        });
    } catch (e) {
        checkBundled();
    }
}
