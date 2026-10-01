// ============================================================
// tests/panel-script-manifest.test.js
//
// Feature: comp-template-pipeline-audit-fix (bugfix spec, task 15.7)
//
// Property 7 — One Canonical Sanitizer (STATIC half).
// The runtime half is tests/sanitizer-cross-implementation.property.test.js,
// which proves the panel and host sanitizers agree on every input. That proof is
// worth nothing unless the implementation the tests `require` is the
// implementation the PANEL LOADS — which is a fact about index.html, not about
// any function. This file asserts exactly that fact and nothing else:
//
//   1. index.html loads js/core/pathBuilders.js.
//   2. It loads it BEFORE js/core/utils.js, so the canonical definitions win the
//      last-writer-wins race in the shared panel global scope.
//   3. getSafeName and generateTemplateId are each defined EXACTLY ONCE across
//      js/, so there is no second rule set for another module to pick up.
//
// Scope note: index.html carries unrelated in-flight local markup changes, so
// this file asserts only the three facts the property needs. No unrelated markup,
// id, class or script is constrained here — tests/cep-compat.test.js and
// tests/class-contract.test.js own that surface.
//
// Uses tests/helpers/static-analysis.js (read / listJsFiles / composeMarkup).
//
// **Validates: Requirement 2.27**
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const sa = require("./helpers/static-analysis");

const html = sa.composeMarkup();

/**
 * The ordered list of `js/...` sources index.html loads, with the cache-busting
 * query stripped. Order is authored order, which is load order for classic
 * (non-module, non-defer) script tags.
 */
function parseScriptManifest(source) {
    const re = /<script[^>]+src=["']([^"']+)["']/gi;
    const out = [];
    let m;
    while ((m = re.exec(source)) !== null) {
        out.push(m[1].split("?")[0].replace(/\\/g, "/"));
    }
    return out;
}

const manifest = parseScriptManifest(html);

/** Count top-level `function <name>(` declarations across every file under js/. */
function countDefinitions(name) {
    const re = new RegExp("(^|\\n)\\s*function\\s+" + name + "\\s*\\(", "g");
    const hits = [];
    sa.listJsFiles().forEach((abs) => {
        const src = fs.readFileSync(abs, "utf8");
        const matches = src.match(re);
        if (matches) {
            hits.push({ file: path.relative(sa.ROOT, abs).replace(/\\/g, "/"), count: matches.length });
        }
    });
    return hits;
}

describe("Property 7 (static) — the tested sanitizer is the loaded sanitizer", () => {
    test("index.html loads js/core/pathBuilders.js", () => {
        expect(manifest).toContain("js/core/pathBuilders.js");
    });

    test("pathBuilders.js precedes js/core/utils.js in load order", () => {
        const pb = manifest.indexOf("js/core/pathBuilders.js");
        const utils = manifest.indexOf("js/core/utils.js");
        expect(pb).toBeGreaterThanOrEqual(0);
        expect(utils).toBeGreaterThanOrEqual(0);
        expect(pb).toBeLessThan(utils);
    });

    test("pathBuilders.js is listed exactly once", () => {
        const hits = manifest.filter((s) => s === "js/core/pathBuilders.js");
        expect(hits.length).toBe(1);
    });

    test("getSafeName is defined exactly once across js/", () => {
        const hits = countDefinitions("getSafeName");
        expect(hits).toEqual([{ file: "js/core/pathBuilders.js", count: 1 }]);
    });

    test("generateTemplateId is defined exactly once across js/", () => {
        const hits = countDefinitions("generateTemplateId");
        expect(hits).toEqual([{ file: "js/core/pathBuilders.js", count: 1 }]);
    });

    test("the canonical module is loadable on its own and exports the string-returning pair", () => {
        // A dependency-free `require` is what the jest suites do; the panel gets
        // the same file through the <script> tag above. If this module ever grew a
        // DOM or CSInterface dependency the two would stop being the same
        // implementation, so the isolated require IS part of the property.
        const pathBuilders = require("../js/core/pathBuilders.js");
        expect(typeof pathBuilders.getSafeName).toBe("function");
        expect(typeof pathBuilders.generateTemplateId).toBe("function");
        expect(typeof pathBuilders.sanitizeNameStrict).toBe("function");
        // The {ok,...} envelope lives on sanitizeNameStrict; the two wrappers
        // return plain strings, which is the shape both the panel call sites and
        // the host port use.
        expect(typeof pathBuilders.getSafeName("x")).toBe("string");
        expect(typeof pathBuilders.generateTemplateId("x")).toBe("string");
        const strict = pathBuilders.sanitizeNameStrict("..");
        expect(typeof strict.ok).toBe("boolean");
        expect(typeof strict.value).toBe("string");
    });

    test("the panel module carries no DOM, CSInterface or Node dependency", () => {
        const src = sa.read(path.join("js", "core", "pathBuilders.js"));
        expect(/\bdocument\b/.test(src)).toBe(false);
        expect(/\bwindow\b/.test(src)).toBe(false);
        expect(/csInterface/i.test(src)).toBe(false);
        expect(/\brequire\s*\(/.test(src)).toBe(false);
    });
});
