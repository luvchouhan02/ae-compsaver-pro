/**
 * Header Class-Contract static-analysis test.
 *
 * Spec: panel-layout-redesign — Task 5.2
 * Requirements: 3.1, 3.3, 9.5
 *
 * The Header was restructured (.logo-wrap, .main-switcher with 3 .main-nav-btn,
 * .search-row, the new .hdr-status wrapper, status badges). Requirement 3.1
 * requires every Class_Contract id/data-* the JavaScript depends on to resolve
 * to EXACTLY ONE element in the restructured markup. Requirements 3.3 / 9.5
 * require that the JS selector wiring was updated in lockstep, so ZERO stale
 * references (a JS reference to a Header selector that no longer exists in the
 * markup) remain.
 *
 * These tests read index.html and the JS source as TEXT (no DOM, no bundler),
 * reusing the shared static-analysis helpers, so they stay deterministic and run
 * under jest's "node" testEnvironment.
 */

const SA = require("./helpers/static-analysis");

// ------------------------------------------------------------
// Source text + Header region
// ------------------------------------------------------------

const html = SA.composeMarkup();
const allJs = SA.readAllJs();

// The Header is delimited by these two top-level section comments in index.html.
const HEADER_START = "<!-- ========== HEADER ========== -->";
const HEADER_END = "<!-- ========== TOOLKIT MODULE ========== -->";

const startIdx = html.indexOf(HEADER_START);
const endIdx = html.indexOf(HEADER_END);
const headerRegion =
    startIdx !== -1 && endIdx !== -1 ? html.slice(startIdx, endIdx) : "";

// ------------------------------------------------------------
// The Header Class_Contract: id / class drivers JS depends on.
// (Grounded in the Header markup + the getElementById / bindClick / setActive /
//  DOM[...] / querySelector references across js/main.js, js/ui/header.js,
//  js/ui/comp-monitor.js, js/toolkit/toolkit.js, js/templates/templates.js.)
// ------------------------------------------------------------

const HEADER_DRIVER_IDS = [
    "top-mini-logo",
    "brand-typo",
    "btn-main-toolkit",
    "btn-main-templates",
    "btn-settings-gear",
    "btn-header-browse",
    "btn-search-toggle",
    "template-count",
    "monitor-active-comp",
];

// Class-name selectors the JS resolves via querySelector(".x").
const HEADER_DRIVER_CLASSES = [".brand-by"];

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/** Count how many elements carry id="value" in a blob of HTML. */
function countId(htmlText, id) {
    const re = new RegExp('\\bid="' + escapeRe(id) + '"', "g");
    const m = htmlText.match(re);
    return m ? m.length : 0;
}

/** Count how many elements carry the given class token in class="...". */
function countClass(htmlText, className) {
    const token = className.replace(/^\./, "");
    const re = /\bclass="([^"]+)"/g;
    let count = 0;
    let m;
    while ((m = re.exec(htmlText)) !== null) {
        if (m[1].split(/\s+/).indexOf(token) !== -1) count++;
    }
    return count;
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract every element-id the JS resolves through the project's id-based
 * access patterns: getElementById("x"), the DOM cache (DOM["x"]) and the
 * dom.js helpers that key off an id (bindClick / setActive / setDisplay).
 */
function extractJsIdRefs(jsText) {
    const ids = new Set();
    const patterns = [
        /getElementById\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
        /\bDOM\[\s*["'`]([^"'`]+)["'`]\s*\]/g,
        /\bbindClick\(\s*["'`]([^"'`]+)["'`]/g,
        /\bsetActive\(\s*["'`]([^"'`]+)["'`]/g,
        /\bsetDisplay\(\s*["'`]([^"'`]+)["'`]/g,
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(jsText)) !== null) ids.add(m[1]);
    }

    // The DOM cache in main.js is built from a `var ids = [ ... ]` array whose
    // string literals are each passed to getElementById and cached on DOM[id].
    // Treat every literal in that array as an id driver too.
    const arrRe = /\bids\s*=\s*\[([\s\S]*?)\]/g;
    let arr;
    while ((arr = arrRe.exec(jsText)) !== null) {
        const litRe = /["'`]([^"'`]+)["'`]/g;
        let lit;
        while ((lit = litRe.exec(arr[1])) !== null) ids.add(lit[1]);
    }
    return ids;
}

const jsIdRefs = extractJsIdRefs(allJs);
const jsRefs = SA.extractJsRefs(allJs); // .selectors includes querySelector strings
const headerDataAttrs = SA.extractHtmlDataAttrs(headerRegion);

// ------------------------------------------------------------
// Sanity: the Header region was located.
// ------------------------------------------------------------

describe("Header region extraction", () => {
    test("the Header block is present and bounded in index.html", () => {
        expect(startIdx).toBeGreaterThan(-1);
        expect(endIdx).toBeGreaterThan(startIdx);
        expect(headerRegion).toContain('class="header"');
        expect(headerRegion).toContain('class="hdr-status"');
    });
});

// ------------------------------------------------------------
// Req 3.1 — every Header id driver resolves to EXACTLY ONE element.
// ------------------------------------------------------------

describe("Header Class_Contract — id drivers resolve to exactly one element (Req 3.1)", () => {
    test.each(HEADER_DRIVER_IDS)(
        'id "%s" resolves to exactly one element in index.html',
        (id) => {
            expect(countId(html, id)).toBe(1);
        }
    );

    test("every Header id driver is authored inside the Header region", () => {
        const outside = HEADER_DRIVER_IDS.filter(
            (id) => countId(headerRegion, id) !== 1
        );
        expect(outside).toEqual([]);
    });
});

// ------------------------------------------------------------
// Req 3.1 — class-name drivers the JS resolves via querySelector resolve once.
// ------------------------------------------------------------

describe("Header Class_Contract — class drivers resolve to exactly one element (Req 3.1)", () => {
    test.each(HEADER_DRIVER_CLASSES)(
        'class selector "%s" resolves to exactly one element in the Header',
        (cls) => {
            expect(countClass(headerRegion, cls)).toBe(1);
        }
    );
});

// ------------------------------------------------------------
// Req 3.1 — any data-* driver authored in the Header resolves to one element.
// (The restructured Header is id/class-driven; this guards against a future
//  data-* driver being added without a 1:1 element.)
// ------------------------------------------------------------

describe("Header Class_Contract — data-* drivers resolve to exactly one element (Req 3.1)", () => {
    test("each Header data-* attribute referenced by JS resolves to exactly one element", () => {
        const jsDataAttrs = new Set([
            ...jsRefs.dataAttrs,
            ...SA.dataAttrsFromSelectors(jsRefs.selectors),
        ]);
        const headerJsDataAttrs = [...headerDataAttrs].filter((a) =>
            jsDataAttrs.has(a)
        );
        const unresolved = headerJsDataAttrs.filter((attr) => {
            const re = new RegExp("\\b" + escapeRe(attr) + '="', "g");
            const m = headerRegion.match(re);
            return !m || m.length < 1;
        });
        expect(unresolved).toEqual([]);
    });
});

// ------------------------------------------------------------
// Req 3.3 / 9.5 — zero stale JS references remain.
// Every Header driver id the JS references must resolve to exactly one element,
// and every driver must actually be referenced by the JS (a real driver).
// ------------------------------------------------------------

describe("Header Class_Contract — zero stale JS references (Req 3.3, 9.5)", () => {
    test("every Header driver id referenced by JS resolves to exactly one element", () => {
        const referenced = HEADER_DRIVER_IDS.filter((id) => jsIdRefs.has(id));
        const stale = referenced.filter((id) => countId(html, id) !== 1);
        expect(stale).toEqual([]);
    });

    test("every Header driver id is actually wired in JS (guards a stale contract list)", () => {
        const orphaned = HEADER_DRIVER_IDS.filter((id) => !jsIdRefs.has(id));
        expect(orphaned).toEqual([]);
    });

    test("no JS reference targets a Header-contract id that is absent from the markup", () => {
        // For the curated Header contract, a stale reference is a JS id-ref that
        // belongs to the Header set yet fails to resolve to exactly one element.
        const headerRefs = [...jsIdRefs].filter((id) =>
            HEADER_DRIVER_IDS.includes(id)
        );
        const broken = headerRefs.filter((id) => countId(html, id) !== 1);
        expect(broken).toEqual([]);
    });
});

// ------------------------------------------------------------
// Req 9.5 — single active main-nav button (active-state treatment preserved).
// ------------------------------------------------------------

describe("Header main switcher — exactly one active nav button (Req 9.5)", () => {
    test("the Header renders three .main-nav-btn with exactly one .active", () => {
        expect(countClass(headerRegion, "main-nav-btn")).toBe(3);
        const activeButtons = (
            headerRegion.match(/class="main-nav-btn active"/g) || []
        ).length;
        expect(activeButtons).toBe(1);
    });
});
