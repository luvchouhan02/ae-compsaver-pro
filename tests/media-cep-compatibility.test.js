"use strict";

/**
 * Scoped static compatibility checks for the media-engine-lag change set.
 *
 * Validates: Requirements 5.2, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9,
 * 6.10, 7.6, 7.7, 7.8, 7.9
 *
 * Everything here reads source files as TEXT. Nothing is executed, so the
 * checks stay deterministic and cheap. Four families of guard live here:
 *
 *   1. CEP-safe syntax + guarded runtime APIs (Req 7.6) for the frontend files
 *      this change set owns — modern syntax and unguarded modern APIs would
 *      break the older-Chromium CEP runtime at parse or call time.
 *   2. No ExtendScript (`.jsx`) file belongs to the change set (Req 7.7).
 *   3. A COMPLEMENTARY hot-callback synchronous-filesystem guard (Req 5.2).
 *      `tests/media-async-io.property.test.js` already guards the picker /
 *      stage / thumbnail / FFmpeg / card-field regions of fastMediaEngine.js;
 *      this file covers the regions that guard does NOT scan: the whole keyed
 *      card helper, the whole scheduler, and the hover-preview regions.
 *   4. Individual hover events emit no console trace and no PerfEvents record
 *      (Req 6.1-6.10 hover control surface, Req 7.8).
 *
 * Anti-vacuity is explicit: every scanned file/region must be found and
 * non-trivial, the change-set anchors must be present, and every detector is
 * self-tested against a synthetic violating fixture so a broken scanner fails
 * instead of silently passing.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// ── Change-set scope ─────────────────────────────────────────────────────────
// The frontend files modified by this change set, each with an anchor proving
// the media-engine work actually landed in it.
const CHANGE_SET_FILES = [
    { file: "js/core/fastMediaEngine.js", anchors: ["MediaImportCoordinator", "MediaWorkCoordinator", "HoverPreviewController"] },
    { file: "js/core/scheduler.js", anchors: ["thumbnail", "cancelByOwner"] },
    { file: "js/core/persistence.js", anchors: ["commitOptimisticBatch", "patchById"] },
    { file: "js/core/observability.js", anchors: ["createMediaScenarioMetrics"] },
    { file: "js/core/keyedMediaCardHelper.js", anchors: ["KeyedMediaCardHelper"] },
    { file: "js/templates/templates.js", anchors: ["renderTemplateCardMarkup", "escapeTemplateCardAttribute"] },
];

// Files whose entire contents are media-engine owned: scanned end to end.
const WHOLE_FILE_SCOPE = [
    "js/core/fastMediaEngine.js",
    "js/core/scheduler.js",
    "js/core/persistence.js",
    "js/core/observability.js",
    "js/core/keyedMediaCardHelper.js",
];

// templates.js is shared: only the single-card markup extracted for the media
// keyed adapter is in scope. Pre-existing save-pipeline code is out of scope.
const REGION_SCOPE = [
    { file: "js/templates/templates.js", marker: "function escapeTemplateCardAttribute(" },
    { file: "js/templates/templates.js", marker: "function renderTemplateCardMarkup(" },
];

// Hover-preview surface inside fastMediaEngine.js, discovered by shape so a
// renamed/added hover member cannot slip past the scan.
const HOVER_REGION_PATTERN =
    /^ {4}(?:function (?:hover[A-Za-z0-9_$]*|HoverPreviewController|initHoverPreviews|getHoverPreviewController)\s*\(|HoverPreviewController\.prototype\.[A-Za-z0-9_$]+\s*=\s*function)/;

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// ── Comment / literal stripping ──────────────────────────────────────────────
/**
 * Replace comments, string literals and regex literals with blanks so token
 * scans only see executable code. Template literals are blanked too, but each
 * one is recorded because a backtick is itself a compatibility violation.
 * Line structure is preserved so reported line numbers stay accurate.
 */
function stripToCode(source) {
    var out = "";
    var templateLiterals = [];
    var line = 1;
    var i = 0;
    var n = source.length;

    function lastCodeChar() {
        for (var k = out.length - 1; k >= 0; k--) {
            var ch = out.charAt(k);
            if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return ch;
        }
        return "";
    }

    function regexAllowedHere() {
        var prev = lastCodeChar();
        if (prev === "") return true;
        if ("(,=:[!&|?{};+-*%~^<>".indexOf(prev) !== -1) return true;
        // `return /re/`, `typeof /re/`, `case /re/` …
        return /\b(?:return|typeof|case|in|of|do|else|void|delete|instanceof)\s*$/.test(out);
    }

    function blank(count) {
        return new Array(count + 1).join(" ");
    }

    while (i < n) {
        var c = source.charAt(i);
        var d = source.charAt(i + 1);

        if (c === "\n") { out += "\n"; line++; i++; continue; }

        if (c === "/" && d === "/") {
            while (i < n && source.charAt(i) !== "\n") i++;
            continue;
        }

        if (c === "/" && d === "*") {
            i += 2;
            while (i < n && !(source.charAt(i) === "*" && source.charAt(i + 1) === "/")) {
                if (source.charAt(i) === "\n") { out += "\n"; line++; }
                i++;
            }
            i += 2;
            continue;
        }

        if (c === '"' || c === "'" || c === "`") {
            if (c === "`") templateLiterals.push(line);
            var quote = c;
            i++;
            out += " ";
            while (i < n) {
                var ch = source.charAt(i);
                if (ch === "\\") { i += 2; continue; }
                if (ch === "\n") { out += "\n"; line++; i++; continue; }
                if (ch === quote) { i++; break; }
                i++;
            }
            continue;
        }

        if (c === "/" && regexAllowedHere()) {
            var j = i + 1;
            var inClass = false;
            var closed = false;
            while (j < n) {
                var rc = source.charAt(j);
                if (rc === "\\") { j += 2; continue; }
                if (rc === "\n") break;
                if (rc === "[") inClass = true;
                else if (rc === "]") inClass = false;
                else if (rc === "/" && !inClass) { closed = true; j++; break; }
                j++;
            }
            if (closed) {
                while (j < n && /[a-z]/.test(source.charAt(j))) j++;
                out += blank(j - i);
                i = j;
                continue;
            }
        }

        out += c;
        i++;
    }

    return { code: out, templateLiterals: templateLiterals };
}

// ── Region extraction ────────────────────────────────────────────────────────
/** Slice the block starting at `marker` up to the closing brace at its indent. */
function extractRegion(source, marker) {
    var lines = source.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf(marker) === -1) continue;
        var indent = /^([ \t]*)/.exec(lines[i])[1];
        var closing = new RegExp("^" + indent + "\\};?$");
        for (var end = i + 1; end < lines.length; end++) {
            if (closing.test(lines[end])) {
                return {
                    marker: marker,
                    startLine: i + 1,
                    endLine: end + 1,
                    text: lines.slice(i, end + 1).join("\n"),
                };
            }
        }
        return null;
    }
    return null;
}

/** Every block whose opening line matches `pattern`, in source order. */
function collectRegions(source, pattern) {
    var lines = source.split(/\r?\n/);
    var regions = [];
    for (var i = 0; i < lines.length; i++) {
        if (!pattern.test(lines[i])) continue;
        var indent = /^([ \t]*)/.exec(lines[i])[1];
        var closing = new RegExp("^" + indent + "\\};?$");
        for (var end = i + 1; end < lines.length; end++) {
            if (closing.test(lines[end])) {
                regions.push({
                    marker: lines[i].trim(),
                    startLine: i + 1,
                    endLine: end + 1,
                    text: lines.slice(i, end + 1).join("\n"),
                });
                break;
            }
        }
    }
    return regions;
}

/** file:line findings for `pattern` inside `code`, offset by `startLine`. */
function findLines(code, pattern, label, startLine) {
    var lines = code.split(/\r?\n/);
    var findings = [];
    for (var i = 0; i < lines.length; i++) {
        var re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
        if (re.test(lines[i])) {
            findings.push(label + ":" + ((startLine || 1) + i) + "  →  " + lines[i].trim().slice(0, 110));
        }
    }
    return findings;
}

// ── Detectors ────────────────────────────────────────────────────────────────
const FORBIDDEN_SYNTAX = [
    { id: "optional-chaining", pattern: /\?\.(?![0-9])/ },
    { id: "nullish-coalescing", pattern: /\?\?/ },
    { id: "arrow-function", pattern: /=>/ },
    { id: "dynamic-import", pattern: /\bimport\s*\(/ },
    { id: "es-module-syntax", pattern: /^\s*(?:import|export)\s+[A-Za-z_${*]/ },
    { id: "let-const-declaration", pattern: /\b(?:let|const)\s+[A-Za-z_$[{]/ },
    { id: "class-declaration", pattern: /\bclass\s+[A-Za-z_$]/ },
    { id: "async-await", pattern: /\basync\s+function\b|\basync\s*\(|\bawait\s+[A-Za-z_$(]/ },
    { id: "generator-function", pattern: /\bfunction\s*\*/ },
    { id: "spread-or-rest", pattern: /\.\.\./ },
    { id: "exponent-operator", pattern: /[^*/]\*\*[^*]/ },
    { id: "bare-animation-frame", pattern: /(?:^|[^.\w$])(?:request|cancel)AnimationFrame\s*\(/ },
];

// Runtime APIs that may be missing in the supported CEP runtime. Any use must
// be accompanied by feature detection in the same file.
const GUARDED_GLOBALS = [
    "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Proxy", "Reflect", "Symbol",
    "AbortController", "FinalizationRegistry", "structuredClone", "queueMicrotask",
    "PerformanceObserver", "ResizeObserver", "IntersectionObserver", "MutationObserver",
    "BroadcastChannel", "OffscreenCanvas", "createImageBitmap", "requestIdleCallback",
    "fetch", "URL", "Blob",
];

function usesGlobal(code, token) {
    return new RegExp("(?:^|[^.\\w$])" + token + "\\b").test(code);
}

function hasGuardEvidence(code, token) {
    var typeofGuard = new RegExp("typeof\\s+(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*" + token + "\\b");
    var truthyGuard = new RegExp("(?:^|[^.\\w$])(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*" + token + "\\s*&&");
    return typeofGuard.test(code) || truthyGuard.test(code);
}

const FS_PROMISES_CALL = /fs\s*\.\s*promises\s*\.\s*([A-Za-z]+)\s*\(/g;

function fsPromisesGaps(code) {
    var gaps = [];
    var seen = Object.create(null);
    var match;
    FS_PROMISES_CALL.lastIndex = 0;
    while ((match = FS_PROMISES_CALL.exec(code)) !== null) {
        var method = match[1];
        if (seen[method]) continue;
        seen[method] = true;
        var guard = new RegExp("typeof\\s+fs\\s*\\.\\s*promises\\s*\\.\\s*" + method + "\\s*===");
        if (!guard.test(code)) gaps.push("fs.promises." + method);
    }
    return gaps;
}

// Same shape as the guard in tests/media-async-io.property.test.js, applied to
// the complementary scopes listed above.
const SYNC_FS_CALL = /\b(?:fs|fsImpl|fsApi|nodeFs|nfs\(\)|require\((?:"fs"|'fs')\))\s*\.\s*[A-Za-z]+Sync\s*\(/;

// Console output or PerfEvents emission reachable from a single hover event.
const HOVER_TRACE_PATTERNS = [
    { id: "console-output", pattern: /\bconsole\s*\.\s*[A-Za-z]+\s*\(/ },
    { id: "perf-events-access", pattern: /\bPerfEvents\b/ },
    { id: "event-emission", pattern: /\.\s*emit\s*\(/ },
    { id: "production-metric-record", pattern: /\brecordProductionMetric\s*\(/ },
    { id: "scenario-lifecycle", pattern: /\b(?:startScenario|finishScenario)\s*\(/ },
];

// ── Loaded scope ─────────────────────────────────────────────────────────────
const SOURCES = CHANGE_SET_FILES.reduce(function (acc, entry) {
    acc[entry.file] = read(entry.file);
    return acc;
}, {});

const ENGINE = SOURCES["js/core/fastMediaEngine.js"];

const SCANNED_UNITS = (function () {
    var units = WHOLE_FILE_SCOPE.map(function (file) {
        return { label: file, text: SOURCES[file], startLine: 1 };
    });
    REGION_SCOPE.forEach(function (entry) {
        var region = extractRegion(SOURCES[entry.file], entry.marker);
        units.push({
            label: entry.file + " [" + entry.marker + "]",
            text: region && region.text,
            startLine: region && region.startLine,
            region: region,
        });
    });
    return units;
})();

const HOVER_REGIONS = collectRegions(ENGINE, HOVER_REGION_PATTERN);

// Synthetic fixture used to prove each detector actually fires.
const VIOLATING_FIXTURE = [
    "function bad(options) {",
    "    const value = options?.value ?? 0;",
    "    let mapped = new Map();",
    "    var pending = [...mapped.keys()].map((k) => k ** 2);",
    "    var controller = new AbortController();",
    "    requestAnimationFrame(function () { });",
    "    fs.existsSync(options.path);",
    "    fs.promises.readFile(options.path);",
    "    console.log(`hover ${value}`, PerfEvents.emit(\"hover\"));",
    "    recordProductionMetric(\"hover\", value);",
    "    return import(\"./late.js\");",
    "}",
].join("\n");

describe("media-engine-lag scoped CEP compatibility", function () {
    // ── Scope integrity (anti-vacuity) ──────────────────────────────────────
    describe("change-set scope is real and non-trivial", function () {
        test.each(CHANGE_SET_FILES)("$file exists, is substantial, and carries its change-set anchors", function (entry) {
            var source = SOURCES[entry.file];
            expect(typeof source).toBe("string");
            expect(source.length).toBeGreaterThan(4000);
            entry.anchors.forEach(function (anchor) {
                expect(source.indexOf(anchor)).toBeGreaterThan(-1);
            });
        });

        test("every scanned unit was located and holds executable code", function () {
            expect(SCANNED_UNITS.length).toBe(WHOLE_FILE_SCOPE.length + REGION_SCOPE.length);
            SCANNED_UNITS.forEach(function (unit) {
                expect(typeof unit.text).toBe("string");
                expect(unit.text.length).toBeGreaterThan(200);
                expect(unit.startLine).toBeGreaterThan(0);
                var code = stripToCode(unit.text).code;
                expect(code.replace(/\s+/g, "").length).toBeGreaterThan(120);
            });
        });

        test("the literal/comment stripper keeps code and drops non-code", function () {
            var stripped = stripToCode([
                "// var commentOnly = () => 1;",
                "/* var blockComment = `x`; */",
                'var quoted = "a => b";',
                "var re = /[\"']/g;",
                "var kept = value + 1;",
                "var tpl = `literal`;",
            ].join("\n"));
            expect(stripped.code).not.toMatch(/commentOnly|blockComment/);
            expect(stripped.code).not.toMatch(/=>/);
            expect(stripped.code).toMatch(/var kept = value \+ 1;/);
            expect(stripped.templateLiterals).toEqual([6]);
        });
    });

    // ── Requirement 7.6: CEP-safe syntax ────────────────────────────────────
    describe("CEP-safe syntax (Req 7.6)", function () {
        test("no scanned unit uses syntax newer than the supported CEP runtime", function () {
            var findings = [];
            SCANNED_UNITS.forEach(function (unit) {
                var stripped = stripToCode(unit.text);
                FORBIDDEN_SYNTAX.forEach(function (rule) {
                    findLines(stripped.code, rule.pattern, unit.label, unit.startLine)
                        .forEach(function (hit) { findings.push(rule.id + "  " + hit); });
                });
                stripped.templateLiterals.forEach(function (offset) {
                    findings.push("template-literal  " + unit.label + ":" + (unit.startLine + offset - 1));
                });
            });
            expect(findings).toEqual([]);
        });

        test("the syntax detector flags a synthetic modern-syntax fixture", function () {
            var stripped = stripToCode(VIOLATING_FIXTURE);
            var flagged = FORBIDDEN_SYNTAX.filter(function (rule) {
                return findLines(stripped.code, rule.pattern, "fixture", 1).length > 0;
            }).map(function (rule) { return rule.id; });

            expect(flagged).toEqual(expect.arrayContaining([
                "optional-chaining", "nullish-coalescing", "arrow-function", "dynamic-import",
                "let-const-declaration", "spread-or-rest", "exponent-operator", "bare-animation-frame",
            ]));
            expect(stripped.templateLiterals.length).toBeGreaterThan(0);
        });
    });

    // ── Requirement 7.6: guarded runtime APIs ───────────────────────────────
    describe("modern runtime APIs are feature-detected (Req 7.6)", function () {
        test("every guarded global used by a scanned unit has feature detection", function () {
            var findings = [];
            SCANNED_UNITS.forEach(function (unit) {
                var code = stripToCode(unit.text).code;
                GUARDED_GLOBALS.forEach(function (token) {
                    if (usesGlobal(code, token) && !hasGuardEvidence(code, token)) {
                        findings.push(unit.label + " uses `" + token + "` without feature detection");
                    }
                });
            });
            expect(findings).toEqual([]);
        });

        test("every fs.promises method used by a scanned unit is feature-detected", function () {
            var findings = [];
            var checked = 0;
            SCANNED_UNITS.forEach(function (unit) {
                var code = stripToCode(unit.text).code;
                FS_PROMISES_CALL.lastIndex = 0;
                if (FS_PROMISES_CALL.test(code)) checked++;
                fsPromisesGaps(code).forEach(function (gap) {
                    findings.push(unit.label + " calls `" + gap + "` without a typeof guard");
                });
            });
            // fastMediaEngine.js is the async filesystem owner: at least one
            // scanned unit must actually exercise fs.promises.
            expect(checked).toBeGreaterThan(0);
            expect(findings).toEqual([]);
        });

        test("performance.now() users retain a Date.now fallback", function () {
            var checked = 0;
            SCANNED_UNITS.forEach(function (unit) {
                var code = stripToCode(unit.text).code;
                if (!/performance\s*\.\s*now\s*\(/.test(code)) return;
                checked++;
                expect(code).toMatch(/typeof\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)*performance\s*\.\s*now|(?:[A-Za-z_$][\w$]*\s*\.\s*)?performance\s*&&/);
                expect(code).toMatch(/Date\s*\.\s*now\s*\(/);
            });
            expect(checked).toBeGreaterThan(0);
        });

        test("the API detectors flag a synthetic unguarded fixture", function () {
            var code = stripToCode(VIOLATING_FIXTURE).code;
            expect(usesGlobal(code, "Map")).toBe(true);
            expect(hasGuardEvidence(code, "Map")).toBe(false);
            expect(usesGlobal(code, "AbortController")).toBe(true);
            expect(hasGuardEvidence(code, "AbortController")).toBe(false);
            expect(fsPromisesGaps(code)).toEqual(["fs.promises.readFile"]);
            expect(hasGuardEvidence('if (window.URL && typeof URL.createObjectURL === "function") { }', "URL")).toBe(true);
        });
    });

    // ── Requirement 7.7: no ExtendScript file in the change set ─────────────
    describe("no ExtendScript file is part of this change set (Req 7.7)", function () {
        var jsxFiles = fs.readdirSync(path.join(ROOT, "jsx"))
            .filter(function (name) { return name.toLowerCase().endsWith(".jsx"); });

        test("ExtendScript files exist, so the exclusion is meaningful", function () {
            expect(jsxFiles.length).toBeGreaterThan(0);
        });

        test("the change-set file list contains no .jsx entry", function () {
            var declared = CHANGE_SET_FILES.map(function (entry) { return entry.file; });
            expect(declared.length).toBeGreaterThan(0);
            expect(declared.filter(function (file) { return /\.jsx$/i.test(file); })).toEqual([]);
            jsxFiles.forEach(function (name) {
                expect(declared).not.toContain("jsx/" + name);
            });
        });

        test("no scanned unit references or rewrites an ExtendScript file", function () {
            var findings = [];
            SCANNED_UNITS.forEach(function (unit) {
                findLines(unit.text, /\.jsx\b/, unit.label, unit.startLine)
                    .forEach(function (hit) { findings.push(hit); });
            });
            expect(findings).toEqual([]);
        });
    });

    // ── Requirement 5.2: complementary hot-callback sync-fs guard ───────────
    describe("hot callbacks make no synchronous filesystem call (Req 5.2)", function () {
        // Complementary to the fastMediaEngine picker/stage/thumbnail/FFmpeg
        // region guard in tests/media-async-io.property.test.js.
        var complementaryUnits = [
            { label: "js/core/keyedMediaCardHelper.js", text: SOURCES["js/core/keyedMediaCardHelper.js"], startLine: 1 },
            { label: "js/core/scheduler.js", text: SOURCES["js/core/scheduler.js"], startLine: 1 },
        ];

        test("the complementary scope is loaded and non-trivial", function () {
            complementaryUnits.forEach(function (unit) {
                expect(unit.text.length).toBeGreaterThan(4000);
            });
            expect(HOVER_REGIONS.length).toBeGreaterThan(15);
        });

        test("keyed card patching and scheduler dispatch use no *Sync filesystem API", function () {
            var findings = [];
            complementaryUnits.forEach(function (unit) {
                var code = stripToCode(unit.text).code;
                findLines(code, SYNC_FS_CALL, unit.label, unit.startLine)
                    .forEach(function (hit) { findings.push(hit); });
            });
            expect(findings).toEqual([]);
        });

        test("hover-preview regions use no *Sync filesystem API", function () {
            var findings = [];
            HOVER_REGIONS.forEach(function (region) {
                var code = stripToCode(region.text).code;
                findLines(code, SYNC_FS_CALL, "js/core/fastMediaEngine.js", region.startLine)
                    .forEach(function (hit) { findings.push(region.marker + "  " + hit); });
            });
            expect(findings).toEqual([]);
        });

        test("the sync-filesystem detector flags a synthetic fixture", function () {
            var code = stripToCode(VIOLATING_FIXTURE).code;
            expect(findLines(code, SYNC_FS_CALL, "fixture", 1).length).toBeGreaterThan(0);
        });
    });

    // ── Requirements 6.1-6.10, 7.8: no per-hover tracing ────────────────────
    describe("individual hover events emit no trace (Req 6.1-6.10, 7.8)", function () {
        test("the hover surface was discovered in full and is non-trivial", function () {
            expect(HOVER_REGIONS.length).toBeGreaterThan(15);
            HOVER_REGIONS.forEach(function (region) {
                expect(region.text.length).toBeGreaterThan(40);
                expect(region.endLine).toBeGreaterThan(region.startLine);
            });
            var markers = HOVER_REGIONS.map(function (region) { return region.marker; }).join("\n");
            ["request", "stop", "_startAttempt", "_activate", "_releaseVideo", "dispose"].forEach(function (member) {
                expect(markers).toContain("HoverPreviewController.prototype." + member + " =");
            });
        });

        test("no hover region writes to the console or emits a PerfEvents record", function () {
            var findings = [];
            HOVER_REGIONS.forEach(function (region) {
                var code = stripToCode(region.text).code;
                HOVER_TRACE_PATTERNS.forEach(function (rule) {
                    findLines(code, rule.pattern, "js/core/fastMediaEngine.js", region.startLine)
                        .forEach(function (hit) { findings.push(rule.id + "  " + region.marker + "  " + hit); });
                });
            });
            expect(findings).toEqual([]);
        });

        test("hover decoder counts reach only the aggregate metrics observer", function () {
            var observer = extractRegion(ENGINE, "HoverPreviewController.prototype._observeDecoderCount = function");
            expect(observer).not.toBeNull();
            expect(observer.text).toMatch(/typeof\s+this\._metrics\.observeDecoderCount\s*===\s*"function"/);
            expect(observer.text).not.toMatch(/\bconsole\b|\bPerfEvents\b/);
        });

        test("the tracing detector is not vacuous: emission tokens exist outside hover", function () {
            var engineCode = stripToCode(ENGINE).code;
            // The tokens the hover scan forbids are real in this file, so the
            // hover regions being clean is a fact and not a missing symbol.
            expect(engineCode).toMatch(/\bPerfEvents\b/);
            expect(engineCode).toMatch(/\brecordProductionMetric\s*\(/);

            var fixtureCode = stripToCode(VIOLATING_FIXTURE).code;
            var flagged = HOVER_TRACE_PATTERNS.filter(function (rule) {
                return findLines(fixtureCode, rule.pattern, "fixture", 1).length > 0;
            }).map(function (rule) { return rule.id; });
            expect(flagged).toEqual(expect.arrayContaining([
                "console-output", "perf-events-access", "event-emission", "production-metric-record",
            ]));
        });
    });
});
