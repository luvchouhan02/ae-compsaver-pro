// ============================================================
// core/pathBuilders.js — pure, dependency-free path helpers
// ------------------------------------------------------------
// Deterministic template-path construction and filesystem-safe
// naming. No DOM, no app state, no ExtendScript-only globals.
// The same file is required by jest (CommonJS) and included by
// ExtendScript, so it is written in ES3-compatible syntax (var +
// function declarations only, no arrow/const/let/shorthand).
//
// Requirements: 12.1, 12.2, 12.3, 12.4, 12.5
// ============================================================

// Maximum length for a sanitized name / template id (Req 12.4).
var PATH_BUILDER_MAX_NAME_LENGTH = 255;

// ------------------------------------------------------------
// normalizeSeparators — Req 12.1
//   - convert every backslash to a forward slash
//   - collapse each run of consecutive separators into one "/"
//   - strip any leading or trailing separator
// Deterministic: identical input always yields identical output.
// ------------------------------------------------------------
function normalizeSeparators(p) {
    if (p === null || p === undefined) return "";
    var s = String(p);
    s = s.replace(/\\/g, "/"); // backslash -> forward slash
    s = s.replace(/\/+/g, "/"); // collapse runs of separators
    s = s.replace(/^\/+/, ""); // strip leading separator
    s = s.replace(/\/+$/, ""); // strip trailing separator
    return s;
}

// Windows reserved device names — a folder with one of these names is not
// addressable, so it must be escaped rather than passed through.
var PATH_BUILDER_RESERVED = {
    "con": true, "prn": true, "aux": true, "nul": true,
    "com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
    "com6": true, "com7": true, "com8": true, "com9": true,
    "lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
    "lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true
};
var PATH_BUILDER_FALLBACK_NAME = "_untitled";

// ------------------------------------------------------------
// cleanName — the panel twin of the host's cleanStr (jsx/core.jsx:66): strip
// CR/LF/TAB, collapse whitespace runs to one space, trim. The host applies this
// BEFORE sanitizing (generateTemplateId(cleanStr(name)) in saveActiveComp); the
// panel did not, so any name containing a tab or a run of spaces produced a
// different folder name on the two sides. Idempotent, so folding it into
// generateTemplateId on both sides is safe.
// ------------------------------------------------------------
function cleanName(s) {
    if (s === null || s === undefined) return "";
    var out = String(s);
    out = out.replace(/[\n\r\t]/g, "");
    out = out.replace(/\s+/g, " ");
    out = out.replace(/^\s+/, "").replace(/\s+$/, "");
    return out;
}

// ------------------------------------------------------------
// sanitizeNameStrict — the ONE filesystem-safe-name rule for the whole product
// (panel + host + tests). Applied in order:
//   1. trim
//   2. replace \ / : * ? " < > | and every C0 control / DEL with "_"
//   3. strip trailing dots and spaces (Windows silently drops them, so
//      "name." and "name" would collide on disk but not in the index)
//   4. escape the traversal names "." and ".." and the reserved device names
//   5. truncate to PATH_BUILDER_MAX_NAME_LENGTH, then re-strip trailing dots/spaces
// For any already-safe name (letters, digits, spaces, dashes, interior dots) the
// output is byte-identical to the previous host getSafeName, so NO existing
// library folder is re-keyed by this change. An EMPTY input still returns "" —
// preserving the shape of existing empty-category paths — while a non-empty
// input that reduces to nothing becomes the fallback.
// Returns { ok:Boolean, value:String, error?:String }.
// ------------------------------------------------------------
function sanitizeNameStrict(name) {
    if (name === null || name === undefined) {
        return { ok: false, value: "", error: "Invalid name: name is empty." };
    }
    var s = String(name);
    s = s.replace(/^\s+/, "").replace(/\s+$/, "");
    if (s.length === 0) {
        return { ok: false, value: "", error: "Invalid name: name is empty." };
    }
    s = s.replace(/[\\\/:\*\?"<>\|]/g, "_");
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[\u0000-\u001F\u007F]/g, "_");
    s = s.replace(/[. ]+$/, "");
    if (s.length > PATH_BUILDER_MAX_NAME_LENGTH) {
        s = s.substring(0, PATH_BUILDER_MAX_NAME_LENGTH);
        s = s.replace(/[. ]+$/, "");
    }
    if (s.length === 0) {
        return { ok: false, value: PATH_BUILDER_FALLBACK_NAME, error: "Invalid name: sanitized to zero characters." };
    }
    if (s === "." || s === "..") {
        return { ok: false, value: PATH_BUILDER_FALLBACK_NAME, error: "Invalid name: path-traversal name." };
    }
    var bare = s.toLowerCase();
    var dot = bare.indexOf(".");
    if (dot > 0) bare = bare.substring(0, dot);
    if (PATH_BUILDER_RESERVED[bare] === true) {
        return { ok: false, value: "_" + s, error: "Invalid name: reserved device name." };
    }
    return { ok: true, value: s };
}

// ------------------------------------------------------------
// getSafeName — Req 12.4, 12.5
// Filesystem-safe category/name segment. Always a String, so this is a
// drop-in replacement for the panel's and host's previous signatures.
// ------------------------------------------------------------
function getSafeName(name) {
    return sanitizeNameStrict(name).value;
}

// ------------------------------------------------------------
// generateTemplateId — Req 12.4, 12.5
// Filesystem-safe template id. Folds in cleanName so it matches the host's
// generateTemplateId(cleanStr(name)) exactly.
// ------------------------------------------------------------
function generateTemplateId(name) {
    return sanitizeNameStrict(cleanName(name)).value;
}

// ------------------------------------------------------------
// buildTemplateFolderPath — Req 12.1
// Construct "root/section/safeCat/templateId" with the separator
// normalization from Req 12.1. Inputs safeCat/templateId are
// expected to already be sanitized by getSafeName/generateTemplateId.
// ------------------------------------------------------------
function buildTemplateFolderPath(root, section, safeCat, templateId) {
    var parts = [root, section, safeCat, templateId];
    var joined = parts.join("/");
    return normalizeSeparators(joined);
}

// ------------------------------------------------------------
// buildAepPath — Req 12.2
// Construct "folderPath/project.aep" with the same normalization.
// ------------------------------------------------------------
function buildAepPath(folderPath) {
    return normalizeSeparators(normalizeSeparators(folderPath) + "/project.aep");
}

// ------------------------------------------------------------
// buildThumbPath — Req 12.3
// Construct "folderPath/thumbnail.png" with the same normalization.
// ------------------------------------------------------------
function buildThumbPath(folderPath) {
    return normalizeSeparators(normalizeSeparators(folderPath) + "/thumbnail.png");
}

// ------------------------------------------------------------
// Dual export guard: CommonJS for jest, harmless no-op under
// ExtendScript (where `module` is undefined and the functions
// above resolve as globals via the include).
// ------------------------------------------------------------
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        buildTemplateFolderPath: buildTemplateFolderPath,
        buildAepPath: buildAepPath,
        buildThumbPath: buildThumbPath,
        getSafeName: getSafeName,
        generateTemplateId: generateTemplateId,
        cleanName: cleanName,
        sanitizeNameStrict: sanitizeNameStrict,
        normalizeSeparators: normalizeSeparators,
        PATH_BUILDER_MAX_NAME_LENGTH: PATH_BUILDER_MAX_NAME_LENGTH,
        PATH_BUILDER_FALLBACK_NAME: PATH_BUILDER_FALLBACK_NAME,
    };
}
