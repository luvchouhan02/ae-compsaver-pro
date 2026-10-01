// ============================================================
// core.jsx - foundation utils, classifier, detection, validate, meta, getAllTemplates
// (ExtendScript module - included by compSaver.jsx; functions are global)
// ============================================================

// =========================================================
// ENCODING
// =========================================================

// NOTE (measured, do not "optimise" this again): rewriting this loop to collect
// into an array and `join("")` once — the standard cure for quadratic string
// append — made the host FIVE TIMES SLOWER on a real 326-template library:
// getAllTemplates("overlay") went from 27.3 s to 136.3 s, comp from 14.5 s to
// 90.9 s, layer from 1.5 s to 6.6 s. ExtendScript's Array implementation and its
// join() are far more expensive than its string concatenation, so the array form
// is a pessimisation here. String append stays.
function encodeBridge(str) {
    var hex = "";
    if (str === null || str === undefined) return hex;
    str = "" + str;
    var i;
    for (i = 0; i < str.length; i++) {
        var h = str.charCodeAt(i).toString(16);
        while (h.length < 4) h = "0" + h;
        hex = hex + h;
    }
    return hex;
}

// Same measured conclusion as encodeBridge: string append beats the array form
// in ExtendScript, so the loop below is unchanged. The added validation is ONE
// native regex pass over the whole payload, not per-chunk work.
var CS_BRIDGE_HEX_RE = /^[0-9a-fA-F]*$/;

function isWellFormedBridgeHex(hex) {
    if (hex === null || hex === undefined) return false;
    var s = "" + hex;
    if (s.length % 4 !== 0) return false;
    return CS_BRIDGE_HEX_RE.test(s);
}

// Byte-for-byte the same algorithm as decodeBridgeStrict in js/core/bridge.js:
// a malformed payload is REPORTED on both sides instead of being decoded into
// two different corrupted strings. The panel used to emit U+0000 for a bad
// chunk while this side silently skipped it, and a trailing partial chunk
// produced a plausible but wrong character on both sides.
function decodeBridgeStrict(hex) {
    if (hex === null || hex === undefined || hex === "") return { ok: true, value: "" };
    var s = "" + hex;
    if (!isWellFormedBridgeHex(s)) {
        return {
            ok: false,
            value: "",
            error: "Malformed Bridge payload (" + s.length +
                " chars; expected a multiple of 4 hex digits)"
        };
    }
    var str = "";
    var i;
    for (i = 0; i < s.length; i = i + 4) {
        str = str + String.fromCharCode(parseInt(s.substr(i, 4), 16));
    }
    return { ok: true, value: str };
}

// Back-compatible wrapper: a malformed payload now yields "" instead of a
// silently corrupted string.
//
// Deliberately self-contained on the fallback path: the slice harnesses in
// tests/comp-pipeline-bug-exploration.test.js and
// tests/comp-pipeline-preservation.property.test.js lift this function out of
// this file by brace-walking a fixed name list that does NOT include
// decodeBridgeStrict, so the sibling may be absent. The typeof guard is the
// same shape every other host caller uses for jsonParse; the inline branch
// repeats the identical validation and the identical append loop so both
// realms decode a payload the same way.
function decodeBridge(hex) {
    if (typeof decodeBridgeStrict === "function") return decodeBridgeStrict(hex).value;
    if (hex === null || hex === undefined || hex === "") return "";
    var s = "" + hex;
    if (s.length % 4 !== 0) return "";
    if (!/^[0-9a-fA-F]*$/.test(s)) return "";
    var str = "";
    var i;
    for (i = 0; i < s.length; i = i + 4) {
        str = str + String.fromCharCode(parseInt(s.substr(i, 4), 16));
    }
    return str;
}

function getISOString() {
    var d = new Date();
    function pad(n) { return n < 10 ? "0" + n : n; }
    return d.getUTCFullYear() + "-" +
        pad(d.getUTCMonth() + 1) + "-" +
        pad(d.getUTCDate()) + "T" +
        pad(d.getUTCHours()) + ":" +
        pad(d.getUTCMinutes()) + ":" +
        pad(d.getUTCSeconds()) + "Z";
}

// =========================================================
// STRING UTILS
// =========================================================

function trimStr(s) {
    if (s === null || s === undefined) return "";
    s = "" + s;
    return s.replace(/^\s+/, "").replace(/\s+$/, "");
}

function cleanStr(s) {
    if (s === null || s === undefined) return "";
    s = "" + s;
    s = s.replace(/[\n\r\t]/g, "");
    s = s.replace(/\s+/g, " ");
    return trimStr(s);
}

// getSafeName — the ONE canonical filesystem-safe-name rule, kept
// behaviourally identical to sanitizeNameStrict in js/core/pathBuilders.js
// (that module is the tested implementation AND, after F5d, the one the panel
// loads). The old version replaced only the illegal separator class, so ".",
// "..", "name." and "" passed straight through and a template could write its
// files outside its own folder. Applied in order:
//   1. trim
//   2. replace \ / : * ? " < > | and every C0 control / DEL with "_"
//   3. strip trailing dots and spaces - Windows silently drops them, so
//      "name." and "name" collide on disk but not in the library index
//   4. escape the traversal names "." / ".." and the Windows reserved device
//      names, neither of which is addressable as a folder
//   5. truncate to 255, then re-strip trailing dots/spaces
// NO RE-KEYING: for any already-safe name - letters, digits, spaces, dashes,
// interior dots - the output is byte-identical to the previous implementation,
// and an EMPTY input still returns "" rather than the fallback, so the shape of
// existing empty-category paths is preserved. Only names that already produced
// a broken or traversing path change, and those have no valid folder on disk.
//
// Deliberately self-contained: the slice harnesses in
// tests/comp-pipeline-bug-exploration.test.js and
// tests/comp-pipeline-preservation.property.test.js lift this function out of
// this file by brace-walking a fixed name list, so it may not depend on any new
// sibling function or module-level constant. trimStr and cleanStr are already on
// that list, which is why generateTemplateId below may call them.
function getSafeName(s) {
    if (s === null || s === undefined) return "";
    var v = trimStr("" + s);
    if (v.length === 0) return "";
    v = v.replace(/[\\\/:\*\?"<>\|]/g, "_");
    v = v.replace(/[\u0000-\u001F\u007F]/g, "_");
    v = v.replace(/[. ]+$/, "");
    if (v.length > 255) {
        v = v.substring(0, 255);
        v = v.replace(/[. ]+$/, "");
    }
    if (v.length === 0) return "_untitled";
    if (v === "." || v === "..") return "_untitled";
    // Reserved device names, compared on the stem before the first interior dot.
    // A delimited-string membership test rather than a lookup table so this
    // function stays self-contained for the slice harnesses described above.
    var bare = v.toLowerCase();
    var dot = bare.indexOf(".");
    if (dot > 0) bare = bare.substring(0, dot);
    var reserved = "|con|prn|aux|nul|com1|com2|com3|com4|com5|com6|com7|com8|com9|lpt1|lpt2|lpt3|lpt4|lpt5|lpt6|lpt7|lpt8|lpt9|";
    if (reserved.indexOf("|" + bare + "|") !== -1) return "_" + v;
    return v;
}

// Emit VALID JSON. The old version passed control characters through raw and
// DELETED \r outright, so jsonStringify — which routes every string and every
// key through here — could produce a document the panel's JSON.parse rejects,
// surfacing a COMPLETED save as "JSON Parse Error".
//
// The control-character scan is a single native regex test, so the common case
// (no controls, which is every cleanStr'd string) costs one pass and skips the
// escape loop entirely — this runs for every string in a 326-template scan.
//
// Self-contained on purpose, exactly like getSafeName above: the slice harnesses
// in tests/comp-pipeline-bug-exploration.test.js and
// tests/comp-pipeline-preservation.property.test.js lift this function out of
// this file by brace-walking a fixed name list, so it may not depend on any new
// sibling function or module-level constant. Hence the inline regex literal and
// the inline hex-digit string rather than shared constants.
function escapeJSON(s) {
    if (s === null || s === undefined) return "";
    s = "" + s;
    s = s.replace(/\\/g, "\\\\");
    s = s.replace(/"/g, '\\"');
    s = s.replace(/\n/g, "\\n");
    s = s.replace(/\r/g, "\\r");
    s = s.replace(/\t/g, "\\t");
    s = s.replace(/\u0008/g, "\\b");
    s = s.replace(/\u000C/g, "\\f");
    if (!/[\u0000-\u001F\u007F]/.test(s)) return s;
    // Any remaining C0 control (and DEL) must be \u-escaped to stay valid JSON.
    var digits = "0123456789abcdef";
    var out = "";
    var i;
    for (i = 0; i < s.length; i++) {
        var code = s.charCodeAt(i);
        if (code < 32 || code === 127) {
            out = out + "\\u00" +
                digits.charAt((code >> 4) & 15) +
                digits.charAt(code & 15);
        } else {
            out = out + s.charAt(i);
        }
    }
    return out;
}

function isHexChar(c) {
    if (!c) return false;
    if (c >= "0" && c <= "9") return true;
    if (c >= "a" && c <= "f") return true;
    if (c >= "A" && c <= "F") return true;
    return false;
}

function safeDecode(s) {
    if (!s) return "";
    s = "" + s;
    var result = "";
    var i = 0;
    var len = s.length;
    while (i < len) {
        var ch = s.charAt(i);
        if (ch === "%" && i + 2 < len) {
            var h1 = s.charAt(i + 1);
            var h2 = s.charAt(i + 2);
            if (isHexChar(h1) && isHexChar(h2)) {
                var code = parseInt(h1 + h2, 16);
                if (!isNaN(code)) {
                    result = result + String.fromCharCode(code);
                    i = i + 3;
                    continue;
                }
            }
        }
        if (ch === "+") {
            result = result + " ";
            i = i + 1;
            continue;
        }
        result = result + ch;
        i = i + 1;
    }
    return result;
}

function jsonStringify(obj) {
    if (obj === null) return "null";
    if (obj === undefined) return "null";
    var type = typeof obj;
    if (type === "number") return "" + obj;
    if (type === "boolean") return obj ? "true" : "false";
    if (type === "string") return '"' + escapeJSON(obj) + '"';
    if (type === "object") {
        if (obj instanceof Array) {
            var items = [];
            var i;
            for (i = 0; i < obj.length; i++) {
                items.push(jsonStringify(obj[i]));
            }
            return "[" + items.join(",") + "]";
        }
        var pairs = [];
        var key;
        for (key in obj) {
            if (obj.hasOwnProperty(key)) {
                pairs.push('"' + escapeJSON(key) + '":' + jsonStringify(obj[key]));
            }
        }
        return "{" + pairs.join(",") + "}";
    }
    return "null";
}

// Strict JSON parser (security, Phase 1): ExtendScript has no native
// JSON.parse, and the legacy eval("(" + content + ")") idiom EXECUTES
// whatever it reads — one crafted meta.json/effect file on a shared library
// meant arbitrary code execution inside After Effects. This recursive-descent
// parser implements the strict JSON grammar with NO code execution: malformed
// input throws, and every caller keeps its existing try/catch fallback. Plain
// objects/arrays only; a "__proto__" key is just an ordinary own property in
// ES3 (no special setter exists to pollute anything). ES3-safe: var only.
function jsonParse(text) {
    var src = "" + text;
    var len = src.length;
    var pos = 0;

    function fail(msg) {
        throw new Error("jsonParse: " + msg + " at position " + pos);
    }

    function skipWs() {
        while (pos < len) {
            var w = src.charAt(pos);
            if (w === " " || w === "\t" || w === "\n" || w === "\r") {
                pos = pos + 1;
            } else {
                break;
            }
        }
    }

    // pos sits on the opening double quote.
    function parseString() {
        pos = pos + 1;
        var out = "";
        while (pos < len) {
            var ch = src.charAt(pos);
            if (ch === '"') {
                pos = pos + 1;
                return out;
            }
            if (ch === "\\") {
                pos = pos + 1;
                if (pos >= len) fail("unterminated escape");
                var esc = src.charAt(pos);
                if (esc === '"') { out = out + '"'; }
                else if (esc === "\\") { out = out + "\\"; }
                else if (esc === "/") { out = out + "/"; }
                else if (esc === "b") { out = out + "\b"; }
                else if (esc === "f") { out = out + "\f"; }
                else if (esc === "n") { out = out + "\n"; }
                else if (esc === "r") { out = out + "\r"; }
                else if (esc === "t") { out = out + "\t"; }
                else if (esc === "u") {
                    var hex = src.substring(pos + 1, pos + 5);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad \\u escape");
                    out = out + String.fromCharCode(parseInt(hex, 16));
                    pos = pos + 4;
                } else {
                    fail("bad escape");
                }
                pos = pos + 1;
            } else {
                out = out + ch;
                pos = pos + 1;
            }
        }
        fail("unterminated string");
        return out;
    }

    function parseNumber() {
        var m = src.substring(pos).match(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/);
        if (!m || m[0] === "" || m[0] === "-") fail("bad number");
        pos = pos + m[0].length;
        return Number(m[0]);
    }

    function literal(word, value) {
        if (src.substring(pos, pos + word.length) === word) {
            pos = pos + word.length;
            return value;
        }
        fail("unexpected token");
        return null;
    }

    function parseArray() {
        pos = pos + 1; // consume [
        var arr = [];
        skipWs();
        if (src.charAt(pos) === "]") {
            pos = pos + 1;
            return arr;
        }
        for (; ;) {
            arr.push(parseValue());
            skipWs();
            var ch = src.charAt(pos);
            if (ch === ",") {
                pos = pos + 1;
                skipWs();
                if (src.charAt(pos) === "]") fail("trailing comma in array");
            } else if (ch === "]") {
                pos = pos + 1;
                return arr;
            } else {
                fail("expected ',' or ']'");
            }
        }
    }

    function parseObject() {
        pos = pos + 1; // consume {
        var obj = {};
        skipWs();
        if (src.charAt(pos) === "}") {
            pos = pos + 1;
            return obj;
        }
        for (; ;) {
            skipWs();
            if (src.charAt(pos) !== '"') fail("expected string key");
            var key = parseString();
            skipWs();
            if (src.charAt(pos) !== ":") fail("expected ':'");
            pos = pos + 1;
            obj[key] = parseValue();
            skipWs();
            var ch = src.charAt(pos);
            if (ch === ",") {
                pos = pos + 1;
                skipWs();
                if (src.charAt(pos) === "}") fail("trailing comma in object");
            } else if (ch === "}") {
                pos = pos + 1;
                return obj;
            } else {
                fail("expected ',' or '}'");
            }
        }
    }

    function parseValue() {
        skipWs();
        if (pos >= len) fail("unexpected end of input");
        var ch = src.charAt(pos);
        if (ch === "{") return parseObject();
        if (ch === "[") return parseArray();
        if (ch === '"') return parseString();
        if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber();
        if (ch === "t") return literal("true", true);
        if (ch === "f") return literal("false", false);
        if (ch === "n") return literal("null", null);
        fail("unexpected character");
        return null;
    }

    var value = parseValue();
    skipWs();
    if (pos !== len) fail("trailing characters after JSON value");
    return value;
}

// Filesystem-safe template id. cleanStr is folded in so the id is derived the
// same way on both sides of the Bridge - js/core/pathBuilders.js
// generateTemplateId folds in its cleanName twin. cleanStr is idempotent, so the
// pre-existing generateTemplateId(cleanStr(name)) call in saveActiveComp keeps
// producing exactly the id it produces today.
function generateTemplateId(name) {
    return getSafeName(cleanStr(name));
}

function getDeterministicTemplateId(name) {
    return generateTemplateId(name);
}

function findTemplateFolder(r, c, id, s) {
    var safeC = getSafeName(c);
    var cleanC = (typeof cleanStr === "function") ? getSafeName(cleanStr(c)) : safeC;
    var safeId = getSafeName(id);
    var genId = (typeof generateTemplateId === "function") ? generateTemplateId(id) : ((typeof cleanStr === "function") ? getSafeName(cleanStr(id)) : safeId);

    if (s) {
        var normSec = normalizeSectionName(s);
        var fS1 = new Folder(r + "/" + normSec + "/" + safeC + "/" + safeId);
        if (fS1.exists) return fS1;
        var fS2 = new Folder(r + "/" + normSec + "/" + cleanC + "/" + genId);
        if (fS2.exists) return fS2;
    }
    // Fallback if section is not provided or exact folder doesn't exist.
    // "element" is a bidirectional alias of "overlay": the panel writes media to
    // <root>/<section.toLowerCase()>, so an element-section asset lands in
    // <root>/element, while normalizeSectionName maps element -> overlay and the
    // exact probe above only ever looks in <root>/overlay. Listing both here
    // finds the asset from either side without touching the mapping.
    var sections = ["comp", "layer", "text", "footage", "effect", "icon", "overlay", "element"];
    var i;
    for (i = 0; i < sections.length; i++) {
        var f1 = new Folder(r + "/" + sections[i] + "/" + safeC + "/" + safeId);
        if (f1.exists) return f1;
        if (genId !== safeId || cleanC !== safeC) {
            var f2 = new Folder(r + "/" + sections[i] + "/" + cleanC + "/" + genId);
            if (f2.exists) return f2;
        }
    }
    for (i = 0; i < sections.length; i++) {
        var f3 = new Folder(r + "/" + sections[i] + "/" + safeC + "/" + id);
        if (f3.exists) return f3;
    }
    return null;
}

// Task 13.1 (F12a) — deterministic pick from a file list. Folder.getFiles(mask)
// returns entries in an unspecified, filesystem-dependent order, so `[0]`
// resolved a multi-.aep template folder differently on different machines.
// Documented precedence:
//   1. the preferred exact name, case-insensitively - "project.aep"
//   2. otherwise the lexicographically smallest name under a TOTAL order
//      - case-insensitive first, case-sensitive as the tie-break
// ES3: manual scan, no dependence on Array.prototype.sort stability.
function csPickDeterministicFile(files, preferredName) {
    if (!files || files.length === 0) return null;
    var want = preferredName ? ("" + preferredName).toLowerCase() : "";
    var best = null;
    var bestKey = null;
    var i;
    for (i = 0; i < files.length; i++) {
        var f = files[i];
        if (!(f instanceof File)) continue;
        var nm = "" + f.name;
        var nmLower = nm.toLowerCase();
        if (want && nmLower === want) return f;
        var key = nmLower + "\u0000" + nm;
        if (bestKey === null || key < bestKey) {
            bestKey = key;
            best = f;
        }
    }
    return best;
}

// Task 13.1 (F12a) — enumerate through the once-per-import memoized enumerator
// (Req 8.2) so this fallback stops re-hitting the disk per template.
// csEnumerateFolderOnce is defined in jsx/import.jsx; ExtendScript hoists every
// //@include'd top-level function into one global scope, which is the same
// arrangement that lets resolveTemplateFiles already call csReadTemplateMeta.
// A csIo enumeration failure degrades to a direct read here rather than
// aborting, because this IS the meta.json-missing degraded path that Req 3.14
// requires to keep working.
function csListTemplateFiles(folder, mask) {
    var files = null;
    try {
        if (typeof csEnumerateFolderOnce === "function") {
            files = csEnumerateFolderOnce(folder, mask);
        }
    } catch (eEnum) { files = null; }
    if (!files) {
        try { files = mask ? folder.getFiles(mask) : folder.getFiles(); } catch (eGet) { files = null; }
    }
    return files ? files : [];
}

function resolveTemplateFiles(r, c, id, s) {
    var folder = findTemplateFolder(r, c, id, s);
    if (!folder || !folder.exists) return null;

    // Task 8.4: obtain the template's metadata CACHE-FIRST and read+parse it at
    // most once per import (Req 8.1/8.3/8.4/10.3). csReadTemplateMeta serves a
    // current Metadata_Cache entry without a disk read, or reads meta.json once
    // on a miss and memoizes the parse for the rest of the import. With no import
    // context active it degrades to a single plain read, matching legacy behavior.
    var metaObj = csReadTemplateMeta(folder);
    if (!metaObj) metaObj = {};

    var mainFileName = metaObj.mainFile || "project.aep";
    var mainFile = new File(folder.fsName + "/" + mainFileName);
    if (!mainFile.exists) {
        // Task 13.1 (F12b) — the ORDER of the ladder is unchanged
        // - meta.mainFile, project.aep, *.aep, *.cseffect, images in the
        // existing extension order - only the tie-break inside each step
        // becomes total, so getAllTemplates' degraded-record behavior is
        // identical (Req 3.14).
        var picked = csPickDeterministicFile(csListTemplateFiles(folder, "*.aep"), "project.aep");
        if (!picked) {
            picked = csPickDeterministicFile(csListTemplateFiles(folder, "*.cseffect"), null);
        }
        if (!picked) {
            // Image fallback: the extension precedence is preserved exactly;
            // within an extension group a "source.*" file - written by
            // savePNGOnly - wins, otherwise the lexicographically smallest name.
            var imgExts = ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.bmp", "*.tif", "*.tiff"];
            var ie;
            for (ie = 0; ie < imgExts.length; ie++) {
                var imgFiles = csListTemplateFiles(folder, imgExts[ie]);
                if (!imgFiles || imgFiles.length === 0) continue;
                var srcPick = null;
                var im;
                for (im = 0; im < imgFiles.length; im++) {
                    var cand = imgFiles[im];
                    if (!(cand instanceof File)) continue;
                    if (("" + cand.name).toLowerCase().indexOf("source") !== 0) continue;
                    if (!srcPick || ("" + cand.name).toLowerCase() < ("" + srcPick.name).toLowerCase()) {
                        srcPick = cand;
                    }
                }
                picked = srcPick ? srcPick : csPickDeterministicFile(imgFiles, null);
                if (picked) break;
            }
        }
        if (picked) mainFile = picked;
    }

    var assetsFolder = new Folder(folder.fsName + "/assets");
    if (!assetsFolder.exists) {
        assetsFolder = new Folder(folder.fsName + "/" + getSafeName(metaObj.name || id) + " Assets");
        if (!assetsFolder.exists) {
            assetsFolder = new Folder(folder.fsName + "/_Assets");
        }
    }

    return {
        folder: folder,
        meta: metaObj,
        mainFile: mainFile,
        assetsFolder: assetsFolder
    };
}

function normalizeSectionName(section) {
    if (!section) return "";
    section = ("" + section).toLowerCase();
    if (section === "transition") return "layer";
    if (section === "png" || section === "image") return "icon";
    if (section === "element") return "overlay";
    if (section === "textprops" || section === "text-properties" || section === "text_properties" || section === "text_props") return "text";
    return section;
}

// Dev-only preview debug logging. Disabled by default so production never
// writes to a user-specific path; flip CS_DEBUG_LOG to true while debugging.
var CS_DEBUG_LOG = false;
function debugLog(msg) {
    if (!CS_DEBUG_LOG) return;
    try {
        var logFile = new File(Folder.temp.fsName + "/CompSaver_preview_debug.txt");
        logFile.open("a");
        logFile.writeln(getISOString() + " [DEBUG] " + msg);
        logFile.close();
    } catch (e) { }
}

// =========================================================
// FILE SYSTEM
// =========================================================

function getDefaultRootPath() {
    try {
        var docs = Folder.myDocuments;
        if (!docs || !docs.fsName) {
            return "C:/Users/" + $.getenv("USERNAME") + "/Documents/CompSaver_Data";
        }
        return docs.fsName.replace(/\\/g, "/") + "/CompSaver_Data";
    } catch (e) {
        return "C:/Users/" + $.getenv("USERNAME") + "/Documents/CompSaver_Data";
    }
}

function selectFolder() {
    try {
        var folder = Folder.selectDialog("Select Library Folder");
        if (!folder) return "";
        var path = folder.fsName.replace(/\\/g, "/");
        return encodeBridge(path);
    } catch (e) {
        return "";
    }
}

// A library root must be an ABSOLUTE path before it is used as a path prefix.
// Without this, an empty or relative root turns "<root>/comp/<cat>/<id>" into
// "/comp/<cat>/<id>" and ensureDeepFolder creates that tree at the volume root,
// writing the template outside the library where no scan will ever find it.
// Accepts drive-letter ("C:/x"), UNC ("//server/share/x") and POSIX ("/Users/x").
function isAbsoluteLibraryRoot(pathStr) {
    if (pathStr === null || pathStr === undefined) return false;
    var p = trimStr("" + pathStr).replace(/\\/g, "/");
    if (p.length === 0) return false;
    if (/^[A-Za-z]:\//.test(p)) return true;
    if (p.substr(0, 2) === "//") return true;
    if (p.charAt(0) === "/") return true;
    return false;
}

// Validate a resolved library root BEFORE any folder is created and before the
// destructive window is entered. The root must be absolute AND resolvable: the
// folder itself exists, or its immediate parent does (so a first-run library can
// still be created). Returns { ok:true, path:String } | { ok:false, error:String }.
function validateLibraryRoot(pathStr) {
    var p = (pathStr === null || pathStr === undefined)
        ? "" : trimStr("" + pathStr).replace(/\\/g, "/");
    if (p.length === 0) {
        return { ok: false, error: "No library root path was provided." };
    }
    if (!isAbsoluteLibraryRoot(p)) {
        return { ok: false, error: "Library root is not an absolute path: " + p };
    }
    p = p.replace(/\/+$/, "");
    var f = new Folder(p);
    if (f.exists) return { ok: true, path: p };
    var parent = null;
    try { parent = f.parent; } catch (eP) { parent = null; }
    if (parent && parent.exists) return { ok: true, path: p };
    return { ok: false, error: "Library root does not exist and cannot be created: " + p };
}

// Create a folder tree and REPORT failure. The old version discarded the
// boolean Folder.create() returns and handed back `new Folder(pathStr)`
// regardless, so its return value carried no success information at all and a
// caller that did not check `.exists` entered its destructive window with no
// target folder. Contract: a Folder that exists, or null.
function ensureDeepFolder(pathStr) {
    try {
        var norm = ("" + pathStr).replace(/\\/g, "/");
        var f = new Folder(norm);
        if (f.exists) return f;

        var parts = norm.split("/");
        var current = parts[0];
        var i;
        for (i = 1; i < parts.length; i++) {
            if (parts[i] === "") continue; // collapse "//" runs
            current = current + "/" + parts[i];
            var cf = new Folder(current);
            if (!cf.exists) {
                var created = false;
                try { created = cf.create(); } catch (eC) { created = false; }
                // Re-test: some volumes/drivers report false yet do create it.
                if (!created && !cf.exists) return null;
            }
        }
        var out = new Folder(norm);
        return out.exists ? out : null;
    } catch (e) {
        return null;
    }
}

function deleteFolderRecursive(folder) {
    try {
        if (!folder || !folder.exists) return;
        var files = folder.getFiles();
        var i;
        for (i = 0; i < files.length; i++) {
            if (files[i] instanceof Folder) {
                deleteFolderRecursive(files[i]);
            } else {
                try { files[i].remove(); } catch (e1) { }
            }
        }
        try { folder.remove(); } catch (e2) { }
    } catch (e) { }
}

function fsEntryName(entry) {
    // ExtendScript File/Folder .name returns a URI-encoded string (space -> %20,
    // unicode percent-escaped). Decode it before building disk paths or matching,
    // otherwise assets with spaces/unicode get copied/looked-up under wrong names.
    try { return decodeURIComponent(entry.name); } catch (e) { return entry.name; }
}

function copyFolderRecursive(sourceFolder, destFolder) {
    // Returns a status object {success: boolean, failedFiles: []} instead of a
    // bare boolean: ExtendScript File.copy returns false on failure (it does
    // NOT throw), so per-file failures must be collected explicitly. Callers
    // must NEVER delete a source until success === true.
    var status = { success: true, failedFiles: [] };
    try {
        if (!sourceFolder.exists) {
            status.success = false;
            status.failedFiles.push(sourceFolder.fsName + " (source folder missing)");
            return status;
        }
        if (!destFolder.exists) {
            if (!destFolder.create()) {
                status.success = false;
                status.failedFiles.push(destFolder.fsName + " (could not create destination folder)");
                return status;
            }
        }
        var files = sourceFolder.getFiles();
        var i;
        for (i = 0; i < files.length; i++) {
            var src = files[i];
            if (src instanceof Folder) {
                var subStatus = copyFolderRecursive(src, new Folder(destFolder.fsName + "/" + fsEntryName(src)));
                if (!subStatus.success) {
                    status.success = false;
                    status.failedFiles = status.failedFiles.concat(subStatus.failedFiles);
                }
            } else {
                var destFile = new File(destFolder.fsName + "/" + fsEntryName(src));
                var copied = false;
                try { copied = src.copy(destFile); } catch (e1) { copied = false; }
                if (!copied) {
                    status.success = false;
                    status.failedFiles.push(src.fsName + " -> " + destFile.fsName);
                }
            }
        }
        return status;
    } catch (e) {
        status.success = false;
        status.failedFiles.push(sourceFolder.fsName + " (" + e.toString() + ")");
        return status;
    }
}

function readFileText(f) {
    if (!f || !f.exists) return "";
    var content = "";
    try {
        f.open("r");
        content = f.read();
    } catch (e) {
        content = "";
    }
    try { f.close(); } catch (e2) { }
    return content || "";
}

// =========================================================
// PROJECT UTILS
// =========================================================

function deselectAllLayers(comp) {
    try {
        if (!comp) return;
        var i;
        for (i = 1; i <= comp.numLayers; i++) {
            try { comp.layer(i).selected = false; } catch (e) { }
        }
    } catch (err) { }
}

function getTopSelectedLayer(comp) {
    try {
        if (!comp || !comp.selectedLayers || comp.selectedLayers.length === 0) return null;
        var top = comp.selectedLayers[0];
        var i;
        for (i = 1; i < comp.selectedLayers.length; i++) {
            if (comp.selectedLayers[i].index < top.index) top = comp.selectedLayers[i];
        }
        return top;
    } catch (e) {
        return null;
    }
}

function generateUniqueTimestamp() {
    var d = new Date();
    return d.getTime().toString() + "_" + Math.floor(Math.random() * 1000000);
}

function getAllProjectNamesLower(excludeIds) {
    var names = {};
    if (!excludeIds) excludeIds = {};
    try {
        var num = app.project.numItems;
        // Bug E fix: the previous ">150 items" early-return handed back an EMPTY
        // set on large projects, silently disabling collision detection (imported
        // comps/folders were never suffixed). Imports are heavyweight one-shot
        // actions and this walk runs exactly ONCE per import (memoized by
        // csExistingNamesOnce in import.jsx), so always scan every item regardless
        // of project size. Never trade a silent empty set for a small freeze risk.
        var i;
        for (i = 1; i <= num; i++) {
            try {
                var item = app.project.item(i);
                if (excludeIds[item.id]) continue;
                if (item.name) names[item.name.toLowerCase()] = true;
            } catch (e) { }
        }
    } catch (e2) { }
    return names;
}

function safeRenameAllImportedItems(importedItems, existingNamesLower) {
    var i;
    for (i = 0; i < importedItems.length; i++) {
        try {
            var item = importedItems[i];
            if (!(item instanceof CompItem) && !(item instanceof FolderItem)) continue;

            // Task 8.9: resolve the collision-free name through the single canonical
            // deterministic resolver (csResolveName in import.jsx) so the rule lives in
            // exactly one place (Req 15.4). Register the assigned name so subsequent
            // resolutions in the same import stay collision-free.
            var newName = csResolveName(item.name, item instanceof CompItem, existingNamesLower);

            try {
                item.name = newName;
                existingNamesLower[newName.toLowerCase()] = true;
            } catch (renameErr) { }
        } catch (e) { }
    }
}

function isSupportedImageFileName(fname) {
    if (!fname) return false;
    return /\.(png|jpg|jpeg|gif|bmp|tiff|tif|svg|webp|ico)$/i.test(fname);
}

function isSupportedVideoFileName(fname) {
    if (!fname) return false;
    return /\.(mp4|mov|avi|mkv|webm|m4v|mpg|mpeg|wmv|flv|mxf)$/i.test(fname);
}

function isSupportedAudioFileName(fname) {
    if (!fname) return false;
    return /\.(mp3|wav|aac|ogg|flac|m4a|wma)$/i.test(fname);
}

function isFootageFileName(fname) {
    return isSupportedVideoFileName(fname) || isSupportedAudioFileName(fname);
}

// =========================================================
// LAYER CLASSIFIER
// =========================================================

/**
 * Infallible check for TextLayer in ExtendScript without relying on `instanceof TextLayer`.
 * In AE ExtendScript, selectedLayers returns generic AVLayer objects whose prototype
 * chain may not match `instanceof TextLayer`. matchName and property inspection provide
 * a 100% reliable determination across all AE versions.
 */
function isTextLayer(layer) {
    if (!layer) return false;
    try {
        if (layer.matchName === "ADBE Text Layer") return true;
        if (typeof TextLayer !== "undefined" && layer instanceof TextLayer) return true;
        if (layer.property && layer.property("ADBE Text Properties") !== null) return true;
    } catch (e) { }
    return false;
}

function classifyLayer(layer) {
    try {
        if (!layer) return "unknown";
        if (isTextLayer(layer)) return "text";
        if (layer instanceof CameraLayer) return "layer";
        if (layer instanceof LightLayer) return "layer";

        if (layer instanceof AVLayer) {
            if (layer.source instanceof CompItem) return "comp";
            if (layer.source instanceof FootageItem) {
                var src = layer.source;
                try {
                    if (src.mainSource && src.mainSource instanceof SolidSource) return "layer";
                } catch (eS) { }
                if (src.file && src.file.exists) {
                    var fname = src.file.name;
                    if (isSupportedImageFileName(fname)) return "image";
                    if (isFootageFileName(fname)) return "footage";
                    return "footage";
                }
                return "layer";
            }
            return "layer";
        }
        return "layer";
    } catch (e) {
        return "unknown";
    }
}

// =========================================================
// EFFECT HELPERS
// =========================================================

function getLayerEffectsGroup(layer) {
    try {
        if (!layer) return null;
        return layer.property("ADBE Effect Parade");
    } catch (e) {
        try { return layer.Effects; } catch (e2) { return null; }
    }
}

function getLayerEffectCount(layer) {
    try {
        var fx = getLayerEffectsGroup(layer);
        if (!fx) return 0;
        return fx.numProperties || 0;
    } catch (e) {
        return 0;
    }
}

function getSelectedEffectsOnLayer(layer) {
    var selected = [];
    try {
        var fx = getLayerEffectsGroup(layer);
        if (!fx) return selected;
        var n = fx.numProperties;
        var i;
        for (i = 1; i <= n; i++) {
            try {
                var eff = fx.property(i);
                if (eff && eff.selected) selected.push(eff);
            } catch (eF) { }
        }
    } catch (e) { }
    return selected;
}

function getAllEffectsOnLayer(layer) {
    var all = [];
    try {
        var fx = getLayerEffectsGroup(layer);
        if (!fx) return all;
        var n = fx.numProperties;
        var i;
        for (i = 1; i <= n; i++) {
            try {
                var eff = fx.property(i);
                if (eff) all.push(eff);
            } catch (eF) { }
        }
    } catch (e) { }
    return all;
}

function getEffectNamesString(effects) {
    var names = [];
    var i;
    for (i = 0; i < effects.length; i++) {
        try { names.push(effects[i].name); } catch (e) { }
    }
    return names.join(", ");
}

function detectEffectsOnSelection() {
    var result = { mode: "none", effects: [], names: "", layer: null };
    try {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) return result;
        var sl = comp.selectedLayers;
        if (!sl || sl.length === 0) return result;
        if (sl.length > 1) return result;

        var layer = sl[0];
        result.layer = layer;

        var selectedEffs = getSelectedEffectsOnLayer(layer);
        if (selectedEffs.length > 0) {
            result.mode = "selected";
            result.effects = selectedEffs;
            result.names = getEffectNamesString(selectedEffs);
            return result;
        }

        var allEffs = getAllEffectsOnLayer(layer);
        if (allEffs.length > 0) {
            result.mode = "all";
            result.effects = allEffs;
            result.names = getEffectNamesString(allEffs);
            return result;
        }

        return result;
    } catch (e) {
        return result;
    }
}

// =========================================================
// AUTO DETECTION
// =========================================================

function buildDetectionResult(type, message, suggestedName) {
    var json = '{"type":"' + escapeJSON(type) + '","message":"' + escapeJSON(message) + '","suggestedName":"' + escapeJSON(suggestedName) + '"}';
    return encodeBridge(json);
}

function getStrictSaveType() {
    try {
        var activeComp = app.project.activeItem;
        if (activeComp instanceof CompItem) {
            var selLayers = activeComp.selectedLayers;
            if (selLayers && selLayers.length > 0) {
                if (selLayers.length === 1) {
                    var fxInfo = detectEffectsOnSelection();
                    if (fxInfo.mode === "selected") {
                        var nameSel = "";
                        if (fxInfo.effects.length === 1) nameSel = fxInfo.effects[0].name;
                        else nameSel = fxInfo.names;
                        return buildDetectionResult("effect", fxInfo.effects.length + " effect(s) selected on layer", nameSel);
                    }
                }

                var types = {};
                var firstLayerName = "";
                var j;
                for (j = 0; j < selLayers.length; j++) {
                    var t = classifyLayer(selLayers[j]);
                    if (t === "unknown") {
                        return buildDetectionResult("error", "Unknown layer type: " + selLayers[j].name, "");
                    }
                    types[t] = (types[t] || 0) + 1;
                    if (j === 0) firstLayerName = selLayers[j].name;
                }

                var typeKeys = [];
                var k;
                for (k in types) {
                    if (types.hasOwnProperty(k)) typeKeys.push(k);
                }

                if (typeKeys.length > 1) {
                    return buildDetectionResult("error", "Mixed layer types not allowed. Select only one type.", "");
                }

                var detected = typeKeys[0];

                if (detected === "comp") {
                    if (selLayers.length > 1) {
                        return buildDetectionResult("error", "Please select only ONE pre-comp layer.", "");
                    }
                    return buildDetectionResult("comp", "Pre-comp layer selected", selLayers[0].source.name);
                }
                if (detected === "text") {
                    return buildDetectionResult("text", selLayers.length + " text layer(s) selected", firstLayerName);
                }
                if (detected === "footage") {
                    return buildDetectionResult("footage", selLayers.length + " footage layer(s) selected", firstLayerName);
                }
                if (detected === "image") {
                    return buildDetectionResult("png", "Image layer selected", firstLayerName);
                }
                if (detected === "layer") {
                    return buildDetectionResult("layer", selLayers.length + " layer(s) selected", firstLayerName);
                }

                return buildDetectionResult("error", "Cannot determine save type.", "");
            }
        }

        // Both the capability and the message now come from the canonical
        // resolver, so the composition the panel NAMES is always the composition
        // the save engine resolves. The typeof guard covers function-slicing
        // harnesses that load this detection path without the canonical alias in
        // scope; the fallback is the SAME implementation, never a second rule set.
        var target = (typeof csResolveCompTarget === "function")
            ? csResolveCompTarget()
            : resolveCompForSave();
        if (!target.ok) {
            return buildDetectionResult("error", target.error, "");
        }
        if (target.source === "project") {
            return buildDetectionResult("comp", "Pre-Comp from Project panel selected", target.comp.name);
        }
        if (target.source === "timeline") {
            // Defensive: the timeline branch above already returned for any
            // non-empty layer selection. Reproduced here so the two functions
            // state the timeline rule identically if that order ever changes.
            return buildDetectionResult("comp", "Pre-comp layer selected", target.comp.name);
        }
        return buildDetectionResult("comp", "Active composition will be saved", target.comp.name);
    } catch (e) {
        return buildDetectionResult("error", "Detection error: " + e.toString(), "");
    }
}

function getSaveCapabilities() {
    var caps = { comp: false, layer: false, text: false, footage: false, png: false, effect: false, primary: "", suggestedName: "", message: "" };
    try {
        var primaryHex = getStrictSaveType();
        var primaryJson = decodeBridge(primaryHex);
        try {
            var pm = primaryJson.match(/"type"\s*:\s*"([^"]*)"/);
            if (pm) caps.primary = pm[1];
            var sm = primaryJson.match(/"suggestedName"\s*:\s*"([^"]*)"/);
            if (sm) caps.suggestedName = sm[1];
            var mm = primaryJson.match(/"message"\s*:\s*"([^"]*)"/);
            if (mm) caps.message = mm[1];
        } catch (eP) { }

        if (caps.primary === "error") {
            return encodeBridge(buildCapsJson(caps));
        }

        if (caps.primary === "comp") caps.comp = true;
        else if (caps.primary === "layer") caps.layer = true;
        else if (caps.primary === "text") caps.text = true;
        else if (caps.primary === "footage") caps.footage = true;
        else if (caps.primary === "png") caps.png = true;
        else if (caps.primary === "effect") caps.effect = true;

        if (caps.primary !== "effect") {
            try {
                var comp = app.project.activeItem;
                if (comp instanceof CompItem) {
                    var sl = comp.selectedLayers;
                    if (sl && sl.length === 1) {
                        var totalEffs = getLayerEffectCount(sl[0]);
                        if (totalEffs > 0) {
                            caps.effect = true;
                        }
                    }
                }
            } catch (eFx) { }
        }

        // Utility Pre-Comp: a single pre-comp layer selected in the timeline is a
        // reusable building block that inserts as ONE layer, so it can ALSO be
        // saved to the Layer section (in addition to Comp). Classification is by
        // purpose, not internal complexity — no limit on the pre-comp's internal
        // layer count. This only adds the Layer option for timeline pre-comp
        // layers; project-panel comps and the active comp remain Comp-only.
        try {
            var compUP = app.project.activeItem;
            if (compUP instanceof CompItem) {
                var slUP = compUP.selectedLayers;
                if (slUP && slUP.length === 1) {
                    var onlyUP = slUP[0];
                    if (onlyUP instanceof AVLayer && onlyUP.source instanceof CompItem) {
                        caps.layer = true;
                    }
                }
            }
        } catch (eUP) { }

        return encodeBridge(buildCapsJson(caps));
    } catch (e) {
        return encodeBridge(buildCapsJson(caps));
    }
}

function buildCapsJson(caps) {
    return '{"comp":' + (caps.comp ? "true" : "false") +
        ',"layer":' + (caps.layer ? "true" : "false") +
        ',"text":' + (caps.text ? "true" : "false") +
        ',"footage":' + (caps.footage ? "true" : "false") +
        ',"png":' + (caps.png ? "true" : "false") +
        ',"effect":' + (caps.effect ? "true" : "false") +
        ',"primary":"' + escapeJSON(caps.primary) + '"' +
        ',"suggestedName":"' + escapeJSON(caps.suggestedName) + '"' +
        ',"message":"' + escapeJSON(caps.message) + '"}';
}

// =========================================================
// COMP RESOLVE — CANONICAL COMP TARGET RESOLUTION
// ---------------------------------------------------------
// ONE resolver for "which composition does a Comp save target?", used by BOTH
// getStrictSaveType (what the panel offers + the message it shows) and
// resolveCompForSave (what the engine saves). They used to walk the same three
// inputs with different acceptance rules, so the panel could advertise a save
// the engine refused (empty selection + open comp) or name a different
// composition than the one that got saved (one project-panel comp alongside a
// non-comp item).
//
// Precedence, evaluated once:
//   1. Timeline selection in the active comp — exactly one pre-comp layer.
//   2. Project-panel selection — exactly one CompItem (non-comp items in the
//      selection are ignored; the explicit click is the stronger signal).
//   3. The active composition itself.
// Returns ok/comp/source on success, ok:false plus error otherwise.
//
// csResolveCompTarget is the canonical NAME; the single implementation lives in
// resolveCompForSave immediately below, because that is the entry point the save
// engine already calls and the one the function-slicing test harnesses load on
// its own. Keeping one body under the name that is always in scope is what
// guarantees the two callers can never drift apart again.
// =========================================================
function csResolveCompTarget() {
    return resolveCompForSave();
}

function resolveCompForSave() {
    try {
        var activeComp = app.project.activeItem;

        if (activeComp instanceof CompItem) {
            var selLayers = null;
            try { selLayers = activeComp.selectedLayers; } catch (eSL) { selLayers = null; }
            if (selLayers && selLayers.length > 0) {
                if (selLayers.length > 1) {
                    return { ok: false, error: "Select only ONE pre-comp layer." };
                }
                var layer = selLayers[0];
                if (layer instanceof AVLayer && layer.source instanceof CompItem) {
                    return { ok: true, comp: layer.source, source: "timeline" };
                }
                return { ok: false, error: "Selected layer is not a precomposition." };
            }
        }

        try {
            var sel = app.project.selection;
            if (sel && sel.length > 0) {
                var selectedComps = [];
                var i;
                for (i = 0; i < sel.length; i++) {
                    if (sel[i] instanceof CompItem) selectedComps.push(sel[i]);
                }
                if (selectedComps.length > 1) {
                    return { ok: false, error: "Please select only ONE composition in the Project panel." };
                }
                if (selectedComps.length === 1) {
                    return { ok: true, comp: selectedComps[0], source: "project" };
                }
                // Zero comps in the selection: fall through to the active comp
                // rather than failing, which is what the panel already offered.
            }
        } catch (eSel) { }

        if (activeComp instanceof CompItem) {
            return { ok: true, comp: activeComp, source: "active" };
        }

        // getStrictSaveType's existing "nothing available" message, kept verbatim
        // and now shared: the engine's old "Select a precomposition first." was
        // both less helpful and inconsistent with what the panel displayed.
        return { ok: false, error: "Please open a composition or select a comp/asset in the Project panel." };
    } catch (e) {
        return { ok: false, error: "Resolution error: " + e.toString() };
    }
}

// =========================================================
// VALIDATE
// =========================================================

function validateSaveRequest(typeHex) {
    try {
        var saveType = cleanStr(decodeBridge(typeHex));
        if (!saveType) return encodeBridge("No save type specified.");

        var capsHex = getSaveCapabilities();
        var capsJson = decodeBridge(capsHex);
        var caps = {};
        // Security (Phase 1): strict parser instead of eval — no code
        // execution on the decoded payload. Parse failure degrades to the
        // same empty-caps object the eval catch produced.
        try { caps = jsonParse(capsJson); } catch (eP) { }

        if (caps.primary === "error") {
            return encodeBridge(caps.message || "Selection invalid.");
        }

        var saveTypeNorm = saveType;
        if (saveType === "icon" || saveType === "overlay" || saveType === "element") saveTypeNorm = "png";
        if (saveType === "text_props") saveTypeNorm = "text";

        if (saveTypeNorm === "comp" && !caps.comp) return encodeBridge("Comp save not available for current selection.");
        if (saveTypeNorm === "layer" && !caps.layer) return encodeBridge("Layer save not available for current selection.");
        if (saveTypeNorm === "text" && !caps.text) return encodeBridge("Text save not available for current selection.");
        if (saveTypeNorm === "footage" && !caps.footage) return encodeBridge("Footage save not available for current selection.");
        if (saveTypeNorm === "png" && !caps.png) return encodeBridge("PNG save not available for current selection.");
        if (saveTypeNorm === "effect" && !caps.effect) return encodeBridge("Effect save not available. Select a layer with at least one effect.");

        return encodeBridge("true");
    } catch (e) {
        return encodeBridge("Validation error: " + e.toString());
    }
}

// =========================================================
// META PARSING
// =========================================================

function parseMetaContent(mc) {
    var result = { type: "", section: "", dim: "", thumbnail: "", hasFrames: false, frameCount: 0 };
    if (!mc) return result;
    try {
        var nameMatch = mc.match(/"name"\s*:\s*"([^"]*)"/);
        if (nameMatch) result.name = nameMatch[1];
        var idMatch = mc.match(/"id"\s*:\s*"([^"]+)"/);
        if (idMatch) result.id = idMatch[1];
        var typeMatch = mc.match(/"type"\s*:\s*"([^"]+)"/);
        if (typeMatch) result.type = typeMatch[1];
        var secMatch = mc.match(/"section"\s*:\s*"([^"]+)"/);
        if (secMatch) result.section = secMatch[1];
        var dimMatch = mc.match(/"dim"\s*:\s*"([^"]*)"/);
        if (dimMatch) result.dim = dimMatch[1];
        var thumbMatch = mc.match(/"thumbnail"\s*:\s*"([^"]+)"/);
        if (thumbMatch) result.thumbnail = thumbMatch[1];
        var mediaTypeMatch = mc.match(/"mediaType"\s*:\s*"([^"]+)"/);
        if (mediaTypeMatch) result.mediaType = mediaTypeMatch[1];
        var sourcePathMatch = mc.match(/"sourcePath"\s*:\s*"([^"]+)"/);
        if (sourcePathMatch) result.sourcePath = sourcePathMatch[1];
        var mediaFileMatch = mc.match(/"mediaFile"\s*:\s*"([^"]+)"/);
        var mainFileMatch = mc.match(/"mainFile"\s*:\s*"([^"]+)"/);

        if (mediaFileMatch) {
            result.mediaFile = mediaFileMatch[1];
        } else if (mainFileMatch) {
            result.mediaFile = mainFileMatch[1]; // Legacy migration mapping
        }

        if (mainFileMatch) result.mainFile = mainFileMatch[1];
        var proxyFileMatch = mc.match(/"proxyFile"\s*:\s*"([^"]+)"/);
        if (proxyFileMatch) result.proxyFile = proxyFileMatch[1];
        if (mc.indexOf('"hasFrames":true') !== -1) result.hasFrames = true;
        if (mc.indexOf('"hasFrames": true') !== -1) result.hasFrames = true;
        var fcMatch = mc.match(/"frameCount"\s*:\s*(\d+)/);
        if (fcMatch) {
            var fc = parseInt(fcMatch[1], 10);
            if (!isNaN(fc)) result.frameCount = fc;
        }
    } catch (e) { }
    return result;
}

function determineItemType(rawType) {
    if (!rawType) return { type: "comp", section: "comp" };
    var t = ("" + rawType).toLowerCase();
    if (t === "layer" || t === "transition") return { type: "layer", section: "layer" };
    if (t === "text_props" || t === "textprops" || t === "text-properties" || t === "text_properties") return { type: "text", section: "text" };
    if (t === "text") return { type: "text", section: "text" };
    if (t === "footage") return { type: "footage", section: "footage" };
    if (t === "effect") return { type: "effect", section: "effect" };
    if (t === "icon" || t === "png" || t === "image") return { type: "icon", section: "icon" };
    if (t === "overlay" || t === "element") return { type: "overlay", section: "overlay" };
    // Bug C: media folders (fastMediaEngine imports) carry type "media" in
    // meta.json. Without this branch they fell through to comp. The record's
    // own "section" field still wins in getAllTemplates when present; the
    // default here covers a meta.json lacking one.
    if (t === "media") return { type: "media", section: "footage" };
    return { type: "comp", section: "comp" };
}

function finalizeSave(r, cat, section, newId, oldId) {
    try {
        if (!oldId || oldId === "") return;
        var oldFolder = new Folder(r + "/" + section + "/" + getSafeName(cat) + "/" + oldId);
        if (oldFolder.exists) {
            var favFile = new File(oldFolder.fsName + "/.fav");
            if (favFile.exists) {
                var newFav = new File(r + "/" + section + "/" + getSafeName(cat) + "/" + newId + "/.fav");
                try {
                    newFav.open("w");
                    newFav.write("1");
                    newFav.close();
                } catch (e) { }
            }
            deleteFolderRecursive(oldFolder);
        }
    } catch (e) { }
}

function isOldCategoryFolder(folder) {
    var name = folder.name.toLowerCase();
    var reserved = ["comp", "layer", "text", "footage", "effect", "icon", "overlay", "_shared"];
    var isReserved = false;
    var rIdx;
    for (rIdx = 0; rIdx < reserved.length; rIdx++) {
        if (reserved[rIdx] === name) {
            isReserved = true;
            break;
        }
    }
    if (!isReserved) return true;
    if (name === "_shared") return false;

    var subfiles = folder.getFiles();
    if (!subfiles) return false;
    var i;
    for (i = 0; i < subfiles.length; i++) {
        if (subfiles[i] instanceof Folder) {
            var metaFile = new File(subfiles[i].fsName + "/meta.json");
            if (metaFile.exists) {
                return true;
            }
        }
    }
    return false;
}

var migrationLog = [];
function logMigration(msg) {
    try {
        migrationLog.push(msg);
    } catch (e) { }
}
function writeMigrationLog(path) {
    try {
        var logFile = new File(path + "/migration.log");
        logFile.open("w");
        logFile.write(migrationLog.join("\r\n"));
        logFile.close();
    } catch (e) { }
}

function migrateOldStructure(path) {
    migrationLog = [];
    logMigration("=== MIGRATION START ===");
    logMigration("Target path: " + path);
    var root = new Folder(path);
    if (!root.exists) {
        logMigration("Root folder does not exist: " + path);
        writeMigrationLog(path);
        return;
    }

    var allItems = root.getFiles();
    if (!allItems) {
        logMigration("No files/folders in root path");
        writeMigrationLog(path);
        return;
    }

    logMigration("Found " + allItems.length + " total entries in root directory");

    var oldCategoriesCount = 0;
    var templatesMovedCount = 0;
    var templatesFailedCount = 0;
    var i;
    for (i = 0; i < allItems.length; i++) {
        var entry = allItems[i];
        if (!(entry instanceof Folder)) continue;
        var folderName = entry.name;
        if (folderName.charAt(0) === ".") continue;
        if (folderName.charAt(0) === "_" && folderName.toLowerCase() !== "_shared") continue;

        var isOld = isOldCategoryFolder(entry);
        logMigration("Checking entry '" + folderName + "': isOldCategoryFolder=" + isOld);
        if (!isOld) continue;

        oldCategoriesCount++;
        var catName = folderName;
        var isReserved = false;
        var rIdx;
        var reserved = ["comp", "layer", "text", "footage", "effect", "icon", "overlay"];
        for (rIdx = 0; rIdx < reserved.length; rIdx++) {
            if (reserved[rIdx] === folderName.toLowerCase()) {
                isReserved = true;
                break;
            }
        }

        var catFolder = entry;
        if (isReserved) {
            var tempName = folderName + "_old_cat";
            logMigration("Category name '" + folderName + "' is reserved. Renaming it to '" + tempName + "'");
            var conflictFolder = new Folder(entry.parent.fsName + "/" + tempName);
            if (conflictFolder.exists) {
                logMigration("Warning: conflict folder already exists, deleting it: " + conflictFolder.fsName);
                deleteFolderRecursive(conflictFolder);
            }
            if (entry.rename(tempName)) {
                catFolder = new Folder(entry.parent.fsName + "/" + tempName);
                catName = folderName;
                logMigration("Successfully renamed category to: " + catFolder.name);
            } else {
                logMigration("Error: failed to rename reserved category '" + folderName + "'");
                continue;
            }
        } else if (folderName.substring(folderName.length - 8) === "_old_cat") {
            catName = folderName.substring(0, folderName.length - 8);
        }

        var templates = catFolder.getFiles();
        if (!templates) {
            logMigration("No templates found inside category folder: " + catFolder.name);
            continue;
        }

        logMigration("Found " + templates.length + " entries in category folder '" + catFolder.name + "'");

        var j;
        for (j = 0; j < templates.length; j++) {
            var tempFolder = templates[j];
            if (!(tempFolder instanceof Folder)) continue;

            var tempName = tempFolder.name;
            var metaFile = new File(tempFolder.fsName + "/meta.json");

            var section = "";
            var type = "";
            var oldMeta = {};

            if (metaFile.exists) {
                var content = readFileText(metaFile);
                try {
                    // Security (Phase 1): strict parser instead of eval — a
                    // malformed meta.json degrades exactly as before (empty
                    // oldMeta, classification falls back to file sniffing).
                    oldMeta = jsonParse(content);
                } catch (e) { }

                section = oldMeta.section || "";
                type = oldMeta.type || "";
            }

            if (section) section = normalizeSectionName(section);
            if (type) type = determineItemType(type).type;

            if (!section && type) {
                section = determineItemType(type).section;
            }
            if (!section) {
                var filesInTemp = tempFolder.getFiles();
                var hasAep = false;
                var hasCseffect = false;
                var hasImg = false;
                var fIdx;
                for (fIdx = 0; fIdx < filesInTemp.length; fIdx++) {
                    var fName = filesInTemp[fIdx].name.toLowerCase();
                    if (fName.substring(fName.length - 4) === ".aep") hasAep = true;
                    if (fName.substring(fName.length - 9) === ".cseffect") hasCseffect = true;
                    if (isSupportedImageFileName(fName) && fName.indexOf("thumbnail") === -1) hasImg = true;
                }
                if (hasCseffect) {
                    section = "effect";
                    type = "effect";
                } else if (hasAep) {
                    section = "comp";
                    type = "comp";
                } else if (hasImg) {
                    section = "icon";
                    type = "icon";
                } else {
                    section = "comp";
                    type = "comp";
                }
            }

            section = normalizeSectionName(section);
            if (!section) section = "comp";
            type = section;

            var id = getDeterministicTemplateId(tempName);
            var targetPath = path + "/" + section + "/" + getSafeName(catName) + "/" + id;
            var targetFolder = new Folder(targetPath);

            var targetMetaFile = new File(targetFolder.fsName + "/meta.json");
            logMigration("Template '" + tempName + "' -> target path: " + targetPath + " (deterministic ID: " + id + ")");

            if (targetFolder.exists) {
                if (targetMetaFile.exists) {
                    // Do NOT delete the source on meta.json existence alone —
                    // verify the destination's key asset files actually exist.
                    var destVerified = false;
                    try {
                        // Security (Phase 1): strict parser instead of eval.
                        var destMeta = jsonParse(readFileText(targetMetaFile));
                        if (destMeta && destMeta.mainFile) {
                            destVerified = (new File(targetFolder.fsName + "/" + destMeta.mainFile)).exists;
                            if (destVerified && destMeta.thumbnail) {
                                destVerified = (new File(targetFolder.fsName + "/" + destMeta.thumbnail)).exists;
                            }
                        } else {
                            // Meta has no mainFile record — look for any known key asset.
                            var destEntries = targetFolder.getFiles();
                            var dIdx;
                            for (dIdx = 0; dIdx < destEntries.length; dIdx++) {
                                var dNameLow = destEntries[dIdx].name.toLowerCase();
                                if (dNameLow === "project.aep" || dNameLow.indexOf("source.") === 0 || dNameLow.indexOf("thumbnail.") === 0) {
                                    destVerified = true;
                                    break;
                                }
                            }
                        }
                    } catch (eVerify) {
                        destVerified = false;
                    }

                    if (destVerified) {
                        logMigration("Template folder already fully migrated at target (key assets verified). Deleting source folder: " + tempFolder.fsName);
                        deleteFolderRecursive(tempFolder);
                        templatesMovedCount++;
                    } else {
                        logMigration("Warning: target folder has meta.json but key assets could not be verified. Source preserved: " + tempFolder.fsName);
                    }
                    continue;
                } else {
                    logMigration("Warning: target folder exists but meta.json is missing (interrupted copy). Re-creating: " + targetFolder.fsName);
                    deleteFolderRecursive(targetFolder);
                }
            }

            ensureDeepFolder(targetPath);

            var filesToMigrate = tempFolder.getFiles();
            var mainFileWritten = "";
            var hasAssetsFolder = false;
            var copyStatus = { success: true, failedFiles: [] };

            if (filesToMigrate) {
                var fIdx2;
                for (fIdx2 = 0; fIdx2 < filesToMigrate.length; fIdx2++) {
                    var f = filesToMigrate[fIdx2];
                    if (f instanceof File) {
                        var fNameLow = f.name.toLowerCase();
                        var ext = f.name.substring(f.name.lastIndexOf("."));

                        if (fNameLow.indexOf("thumbnail.") === 0) {
                            var destThumb = new File(targetFolder.fsName + "/thumbnail.png");
                            if (!f.copy(destThumb)) {
                                copyStatus.success = false;
                                copyStatus.failedFiles.push(f.name + " -> thumbnail.png");
                            }
                        } else if (fNameLow === "meta.json") {
                            // skip
                        } else if (fNameLow === ".fav") {
                            var destFav = new File(targetFolder.fsName + "/.fav");
                            if (!f.copy(destFav)) {
                                copyStatus.success = false;
                                copyStatus.failedFiles.push(f.name + " -> .fav");
                            }
                        } else {
                            var isMain = false;
                            if (section === "icon" || section === "overlay") {
                                if (isSupportedImageFileName(fNameLow)) {
                                    isMain = true;
                                }
                            } else {
                                if (ext.toLowerCase() === ".aep" || ext.toLowerCase() === ".cseffect") {
                                    isMain = true;
                                }
                            }

                            if (isMain) {
                                var mainName = (section === "icon" || section === "overlay") ? "source" + ext : "project.aep";
                                var destMain = new File(targetFolder.fsName + "/" + mainName);
                                if (!f.copy(destMain)) {
                                    copyStatus.success = false;
                                    copyStatus.failedFiles.push(f.name + " -> " + mainName);
                                } else {
                                    mainFileWritten = mainName;
                                }
                            } else {
                                var destOther = new File(targetFolder.fsName + "/" + f.name);
                                if (!f.copy(destOther)) {
                                    copyStatus.success = false;
                                    copyStatus.failedFiles.push(f.name + " -> " + f.name);
                                }
                            }
                        }
                    } else if (f instanceof Folder) {
                        var destAssets = new Folder(targetFolder.fsName + "/assets");
                        var assetsStatus = copyFolderRecursive(f, destAssets);
                        if (!assetsStatus.success) {
                            copyStatus.success = false;
                            copyStatus.failedFiles = copyStatus.failedFiles.concat(assetsStatus.failedFiles);
                        }
                        hasAssetsFolder = true;
                    }
                }
            }

            // Any copy failed -> abort this template's migration, keep the source.
            if (!copyStatus.success) {
                logMigration("ERROR: template '" + tempName + "' copy failed (" + copyStatus.failedFiles.length + " file(s): " + copyStatus.failedFiles.join("; ") + "). Source folder preserved: " + tempFolder.fsName);
                templatesFailedCount++;
                continue;
            }

            var newMeta = {};
            var prop;
            for (prop in oldMeta) {
                if (oldMeta.hasOwnProperty(prop)) {
                    newMeta[prop] = oldMeta[prop];
                }
            }

            newMeta.schemaVersion = 2;
            newMeta.id = id;
            newMeta.name = oldMeta.name || tempName;
            newMeta.section = section;
            newMeta.type = type;
            newMeta.category = catName;
            newMeta.mainFile = mainFileWritten || ((section === "icon" || section === "overlay") ? "source.png" : "project.aep");
            newMeta.thumbnail = "thumbnail.png";
            newMeta.assetsDir = hasAssetsFolder ? "assets/" : "";
            newMeta.updatedAt = getISOString();
            if (!newMeta.createdAt) {
                newMeta.createdAt = oldMeta.createdAt || newMeta.updatedAt;
            }

            var metaWritten = false;
            try {
                if (targetMetaFile.open("w")) {
                    metaWritten = targetMetaFile.write(jsonStringify(newMeta));
                    targetMetaFile.close();
                }
            } catch (eMetaW) {
                metaWritten = false;
            }
            if (!metaWritten) {
                logMigration("ERROR: template '" + tempName + "' meta.json write failed at target. Source folder preserved: " + tempFolder.fsName);
                templatesFailedCount++;
                continue;
            }

            logMigration("Template '" + tempName + "' migrated successfully (all copies verified). Deleting source folder: " + tempFolder.fsName);
            deleteFolderRecursive(tempFolder);
            templatesMovedCount++;
        }

        logMigration("Checking if category folder is empty: " + catFolder.fsName);
        var remainingInCat = catFolder.getFiles();
        if (!remainingInCat || remainingInCat.length === 0) {
            logMigration("Category folder is empty, deleting it: " + catFolder.fsName);
            deleteFolderRecursive(catFolder);
        } else {
            logMigration("Warning: category folder is not empty (remaining files: " + remainingInCat.length + "), keeping it.");
        }
    }

    logMigration("=== MIGRATION COMPLETE ===");
    logMigration("Old categories processed: " + oldCategoriesCount);
    logMigration("Templates moved: " + templatesMovedCount);
    logMigration("Templates failed (source preserved): " + templatesFailedCount);
    writeMigrationLog(path);
}

// =========================================================
// GET ALL TEMPLATES
// =========================================================

// Session guard: migrateOldStructure is a full recursive tree walk. It only
// needs to run once after the panel (re)loads, not on every getAllTemplates
// call. Persists across evalScript calls within the same JSX engine session.
var __cs_migrationDone = false;

function getAllTemplates(rHex, sHex) {
    // Collected records live OUTSIDE the try so a mid-scan failure in the catch
    // can still return the partial results instead of emptying the library.
    var list = [];
    try {
        var path = "";
        if (rHex) path = cleanStr(decodeBridge(rHex)).replace(/\\/g, "/");
        if (!path) path = getDefaultRootPath();

        try {
            if (!__cs_migrationDone) {
                migrateOldStructure(path);
                __cs_migrationDone = true;
            }
        } catch (migErr) { __cs_migrationDone = true; }

        var root = new Folder(path);
        if (!root.exists) return encodeBridge("[]");

        var sectionFilter = "";
        if (sHex) sectionFilter = normalizeSectionName(cleanStr(decodeBridge(sHex)));

        // "element" is a bidirectional alias of "overlay" on disk: the panel's
        // media writer stores under <root>/<section.toLowerCase()>, so an
        // element-section asset lands in <root>/element, while
        // normalizeSectionName folds element into overlay. Both spellings are
        // therefore walked - on the unfiltered scan, and on an overlay-filtered
        // chunk so a panel that only knows the seven canonical folders still
        // sees element assets.
        var sectionsToScan = [];
        if (sectionFilter) {
            sectionsToScan.push(sectionFilter);
            if (sectionFilter === "overlay") sectionsToScan.push("element");
            else if (sectionFilter === "element") sectionsToScan.push("overlay");
        } else {
            sectionsToScan = ["comp", "layer", "text", "footage", "effect", "icon", "overlay", "element"];
        }

        var sIdx;
        for (sIdx = 0; sIdx < sectionsToScan.length; sIdx++) {
            var sectionName = sectionsToScan[sIdx];
            var sectionFolder = new Folder(path + "/" + sectionName);
            if (!sectionFolder.exists) continue;

            var cats = sectionFolder.getFiles();
            if (!cats) continue;

            var i;
            for (i = 0; i < cats.length; i++) {
                if (!(cats[i] instanceof Folder)) continue;
                if (cats[i].name.charAt(0) === "_") continue;

                var catName = safeDecode(cats[i].name);
                var items = cats[i].getFiles();
                if (!items) continue;

                var j;
                for (j = 0; j < items.length; j++) {
                    if (!(items[j] instanceof Folder)) continue;

                    // Per-item isolation: one throwing folder must not abort
                    // scanning of the remaining items/categories/sections.
                    // The outer catch still returns whatever was collected.
                    try {
                        var itemFolder = items[j];
                        var itemFolderPath = itemFolder.fsName.replace(/\\/g, "/");
                        var folderId = safeDecode(itemFolder.name);

                        var tItemStart = $.hiresTimer;
                        var _p_fsOps = 0, _p_json = 0, _p_thumb = 0;

                        var name = folderId;
                        // Normalized so a record scanned out of the "element"
                        // alias folder reports the canonical "overlay" section
                        // even when meta.json is missing. Identity for all seven
                        // canonical folder names, so no other section changes.
                        var canonicalSection = normalizeSectionName(sectionName);
                        var itemType = canonicalSection;
                        var sectionType = canonicalSection;
                        var itemDim = "";
                        var thumbRelative = "";
                        var hasFrames = false;
                        var frameCount = 0;

                        var tMetaFsStart = $.hiresTimer;
                        var metaFile = new File(itemFolderPath + "/meta.json");
                        var parsed = null;
                        if (metaFile.exists) {
                            var mc = readFileText(metaFile);
                            var tMetaFsEnd = $.hiresTimer;
                            _p_fsOps += (tMetaFsEnd - tMetaFsStart);

                            var tParseStart = $.hiresTimer;
                            try { parsed = parseMetaContent(mc); } catch (eParse) { parsed = null; }
                            var tParseEnd = $.hiresTimer;
                            _p_json += (tParseEnd - tParseStart);
                        } else {
                            _p_fsOps += ($.hiresTimer - tMetaFsStart);
                        }

                        // A missing/corrupt meta.json must not abort the whole scan:
                        // fall back to defaults and emit a degraded record instead.
                        if (parsed) {
                            var typed = determineItemType(parsed.type);
                            itemType = typed.type;
                            if (parsed.section) sectionType = normalizeSectionName(parsed.section);
                            else sectionType = typed.section;
                            if (!sectionType) sectionType = typed.section;
                            itemDim = parsed.dim || "";
                            thumbRelative = parsed.thumbnail || "";
                            hasFrames = parsed.hasFrames ? true : false;
                            frameCount = parsed.frameCount || 0;
                            name = parsed.name || folderId;
                        }

                        var framesFolder = new Folder(itemFolderPath + "/frames");
                        if (framesFolder.exists) {
                            var frameFiles = framesFolder.getFiles("frame_*.png");
                            if (frameFiles && frameFiles.length > 0) {
                                hasFrames = true;
                                frameCount = frameFiles.length;
                            } else {
                                hasFrames = false;
                                frameCount = 0;
                            }
                        } else if (hasFrames) {
                            hasFrames = false;
                            frameCount = 0;
                        }

                        var tThumbStart = $.hiresTimer;
                        var thumbPath = "";
                        if (thumbRelative) {
                            var candidate = new File(itemFolderPath + "/" + thumbRelative);
                            if (candidate.exists) thumbPath = candidate.fsName.replace(/\\/g, "/");
                        }
                        if (!thumbPath) {
                            var allItemFiles = itemFolder.getFiles();
                            if (allItemFiles) {
                                var tf;
                                for (tf = 0; tf < allItemFiles.length; tf++) {
                                    if (!(allItemFiles[tf] instanceof File)) continue;
                                    var fnLow = allItemFiles[tf].name.toLowerCase();
                                    if (fnLow.indexOf("thumbnail.") === 0) {
                                        thumbPath = allItemFiles[tf].fsName.replace(/\\/g, "/");
                                        break;
                                    }
                                }
                            }
                        }
                        _p_thumb += ($.hiresTimer - tThumbStart);

                        var isFav = new File(itemFolderPath + "/.fav").exists;

                        // Bug C: a media folder's NAME is the hex-encoded id
                        // segment (mediaIdFolderSegment), so the emitted record
                        // must carry the REAL id recorded in meta.json or the
                        // index can never match it during reconciliation.
                        var recordId = folderId;
                        if (parsed && parsed.type === "media" && parsed.id) recordId = parsed.id;

                        var previewPath = "";
                        var previewMtime = 0;
                        var previewCandidates = ["preview.apng", "preview.webp"];
                        var pc;
                        for (pc = 0; pc < previewCandidates.length; pc++) {
                            var pFile = new File(itemFolderPath + "/" + previewCandidates[pc]);
                            if (pFile.exists) {
                                previewPath = pFile.fsName.replace(/\\/g, "/");
                                try { previewMtime = pFile.modified.getTime(); } catch (eM) { }
                                break;
                            }
                        }

                        list.push('{"name":"' + escapeJSON(name) + '","id":"' + escapeJSON(recordId) +
                            '","category":"' + escapeJSON(catName) +
                            '","thumbnail":"' + escapeJSON(thumbPath) + '","favorite":' + (isFav ? "true" : "false") +
                            ',"type":"' + escapeJSON(itemType) + '","section":"' + escapeJSON(sectionType) +
                            '","dim":"' + escapeJSON(itemDim) + '","hasFrames":' + (hasFrames ? "true" : "false") +
                            ',"frameCount":' + frameCount + ',"folderPath":"' + escapeJSON(itemFolderPath) + '"' +
                            ',"mediaType":"' + escapeJSON((parsed && parsed.mediaType) || "") + '"' +
                            ',"mediaFile":"' + escapeJSON(parsed && parsed.mediaFile ? parsed.mediaFile : "") + '"' +
                            ',"sourcePath":"' + escapeJSON(parsed && parsed.sourcePath ? parsed.sourcePath : "") + '"' +
                            ',"proxyFile":"' + escapeJSON(parsed && parsed.proxyFile ? parsed.proxyFile : "") + '"' +
                            ',"previewPath":"' + escapeJSON(previewPath) + '","previewMtime":' + previewMtime +
                            ',"_profile_fsOps":' + (_p_fsOps / 1000).toFixed(3) +
                            ',"_profile_json":' + (_p_json / 1000).toFixed(3) +
                            ',"_profile_thumb":' + (_p_thumb / 1000).toFixed(3) +
                            '}');
                    } catch (eItem) {
                        continue;
                    }
                }
            }
        }
        return encodeBridge("[" + list.join(",") + "]");
    } catch (e) {
        // One bad folder must not empty the library: return whatever valid
        // entries were collected before the error instead of a wholesale "[]".
        return encodeBridge("[" + list.join(",") + "]");
    }
}

