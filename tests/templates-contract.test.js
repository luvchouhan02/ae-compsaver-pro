/**
 * Templates switcher + Card_Grid contract (static-analysis) test.
 *
 * Spec: panel-layout-redesign — Task 10.2
 * Requirements: 3.1, 3.3, 14.2, 14.5
 *
 * The Templates_Module was restructured into a `.tpl-toolbar` region whose
 * `.section-switcher` carries the 7-button section switcher (Comp / Icon /
 * Image / Transitions / Text / Footage / Effects), followed by six
 * `.section-content > .grid-container` Card_Grids.
 *
 * The switcher is **id-driven** (there are no `data-*` attributes on the section
 * buttons). The Class_Contract the JS depends on is therefore the set of
 * `btn-section-*` element ids, which `js/main.js` caches + binds (`bindClick`)
 * and `js/ui/header.js` toggles (`setActive`). Requirement 3.1 requires each of
 * those id drivers to resolve to EXACTLY ONE element in the restructured markup;
 * Requirement 3.3 requires the JS wiring to stay in lockstep (zero stale refs).
 * Requirement 14.5 requires exactly one switcher button to render `.active` by
 * default, and Requirement 14.2 requires the template/icon cards to lay out with
 * the shared Card_Grid pattern (`repeat(auto-fill, minmax(...))`) using the
 * `--grid-gap` Spacing_Scale token.
 *
 * These tests read index.html, the JS sources, and css/templates.css as TEXT
 * (no DOM, no bundler), reusing the shared static-analysis helpers so they stay
 * deterministic under jest's "node" testEnvironment. The driver id set is
 * derived from the JS sources (setActive / bindClick / the DOM-cache id array),
 * not hardcoded, so the contract is grounded in what the code actually selects.
 */

const SA = require("./helpers/static-analysis");

// ------------------------------------------------------------
// Source text + Templates region bounds
// ------------------------------------------------------------

const html = SA.composeMarkup();
const allJs = SA.readAllJs();
const templatesCss = SA.read("css/templates.css");

// The Templates module begins at its top-level section comment and ends where
// the first standalone modal (the Save modal) begins.
const TPL_START = "<!-- ========== TEMPLATES MODULE ========== -->";
const TPL_END = "<!-- SAVE MODAL -->";

const tplStart = html.indexOf(TPL_START);
const tplEnd = html.indexOf(TPL_END);
const templatesRegion =
    tplStart !== -1 && tplEnd !== -1 ? html.slice(tplStart, tplEnd) : "";

// The section switcher sits at the top of the module inside `.section-switcher`.
// Slice it out so the "exactly one .active" check only considers switcher
// buttons (other buttons in the toolbar — cat pills, icon-btns — are excluded).
const switcherStart = templatesRegion.indexOf('class="section-switcher"');
const tabsWrapperStart = templatesRegion.indexOf('class="tabs-wrapper"');
const switcherRegion =
    switcherStart !== -1 && tabsWrapperStart !== -1
        ? templatesRegion.slice(switcherStart, tabsWrapperStart)
        : "";

// ------------------------------------------------------------
// The switcher Class_Contract: the btn-section-* id drivers JS depends on.
// (Derived below from the JS sources; this curated list documents intent and
//  guards against a switcher button being dropped from the markup.)
// ------------------------------------------------------------

const SWITCHER_DRIVER_IDS = [
    "btn-section-comp",
    "btn-section-png",
    "btn-section-overlay",
    "btn-section-transition",
    "btn-section-text",
    "btn-section-footage",
    "btn-section-effect",
];

// The six template/icon Card_Grid containers authored in the module.
const GRID_CONTAINER_IDS = [
    "comp-list-container",
    "transition-list-container",
    "text-list-container",
    "footage-list-container",
    "effect-list-container",
    "icon-list-container",
];

// ------------------------------------------------------------
// Helpers (pure text analysis)
// ------------------------------------------------------------

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count how many elements carry id="value" in a blob of HTML. */
function countId(htmlText, id) {
    const re = new RegExp('\\bid="' + escapeRe(id) + '"', "g");
    const m = htmlText.match(re);
    return m ? m.length : 0;
}

/** Collect every opening tag whose text contains `substr`. */
function openingTagsContaining(htmlText, substr) {
    const tagRe = /<[a-zA-Z][^>]*>/g; // [^>] spans newlines, so multi-line tags match
    const out = [];
    let m;
    while ((m = tagRe.exec(htmlText)) !== null) {
        if (m[0].indexOf(substr) !== -1) out.push(m[0]);
    }
    return out;
}

/**
 * Extract every element id the JS resolves through the project's id-based
 * access patterns: getElementById("x"), the DOM cache (DOM["x"]) and the
 * dom.js helpers keyed off an id (bindClick / setActive / setDisplay), plus the
 * `var ids = [ ... ]` cache array in main.js.
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
    const arrRe = /\bids\s*=\s*\[([\s\S]*?)\]/g;
    let arr;
    while ((arr = arrRe.exec(jsText)) !== null) {
        const litRe = /["'`]([^"'`]+)["'`]/g;
        let lit;
        while ((lit = litRe.exec(arr[1])) !== null) ids.add(lit[1]);
    }
    return ids;
}

/**
 * Extract the body of the base `.grid-container { ... }` rule (the one that
 * declares grid-template-columns), so the Card_Grid pattern can be asserted on
 * the real authored rule rather than a hardcoded string.
 */
function extractBaseGridRule(cssText) {
    const re = /\.grid-container\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(cssText)) !== null) {
        if (/grid-template-columns/.test(m[1])) return m[1];
    }
    return "";
}

const jsIdRefs = extractJsIdRefs(allJs);
const gridRule = extractBaseGridRule(templatesCss);

// ------------------------------------------------------------
// Sanity: regions were located.
// ------------------------------------------------------------

describe("Templates region extraction", () => {
    test("the Templates module block is present and bounded in index.html", () => {
        expect(tplStart).toBeGreaterThan(-1);
        expect(tplEnd).toBeGreaterThan(tplStart);
        expect(templatesRegion).toContain('id="templates-module"');
        expect(templatesRegion).toContain('class="section-switcher"');
    });

    test("the section-switcher region was isolated from the rest of the toolbar", () => {
        expect(switcherStart).toBeGreaterThan(-1);
        expect(tabsWrapperStart).toBeGreaterThan(switcherStart);
        expect(switcherRegion).toContain("section-btn");
    });

    test("the base .grid-container rule was located in templates.css", () => {
        expect(gridRule).not.toBe("");
    });
});

// ------------------------------------------------------------
// Req 3.1 — each switcher id driver resolves to EXACTLY ONE element.
// (The switcher is id-driven; there are no data-* selectors on the buttons.)
// ------------------------------------------------------------

describe("Templates switcher Class_Contract — id drivers resolve to exactly one element (Req 3.1, 14.5)", () => {
    test.each(SWITCHER_DRIVER_IDS)(
        'switcher id "%s" resolves to exactly one element in index.html',
        (id) => {
            expect(countId(html, id)).toBe(1);
        }
    );

    test("every switcher id driver is authored inside the .section-switcher region", () => {
        const outside = SWITCHER_DRIVER_IDS.filter(
            (id) => countId(switcherRegion, id) !== 1
        );
        expect(outside).toEqual([]);
    });

    test("the switcher renders exactly seven .section-btn buttons", () => {
        const btnTags = openingTagsContaining(switcherRegion, "section-btn");
        expect(btnTags.length).toBe(7);
    });
});

// ------------------------------------------------------------
// Req 3.3 — zero stale JS references to the switcher contract.
// Every switcher id the JS references must resolve to exactly one element, and
// every curated driver must actually be wired in the JS (a real driver).
// ------------------------------------------------------------

describe("Templates switcher Class_Contract — zero stale JS references (Req 3.3)", () => {
    test("every switcher driver id referenced by JS resolves to exactly one element", () => {
        const referenced = SWITCHER_DRIVER_IDS.filter((id) => jsIdRefs.has(id));
        const stale = referenced.filter((id) => countId(html, id) !== 1);
        expect(stale).toEqual([]);
    });

    test("every switcher driver id is actually wired in the JS (guards a stale contract list)", () => {
        const orphaned = SWITCHER_DRIVER_IDS.filter((id) => !jsIdRefs.has(id));
        expect(orphaned).toEqual([]);
    });
});

// ------------------------------------------------------------
// Req 14.5 — exactly one switcher button renders .active by default.
// ------------------------------------------------------------

describe("Templates switcher — exactly one active button by default (Req 14.5)", () => {
    test("exactly one .section-btn carries the active class", () => {
        const btnTags = openingTagsContaining(switcherRegion, "section-btn");
        const activeBtns = btnTags.filter((tag) =>
            /class="[^"]*\bsection-btn\b[^"]*\bactive\b[^"]*"/.test(tag)
        );
        expect(activeBtns.length).toBe(1);
    });
});

// ------------------------------------------------------------
// Req 14.2 — template/icon cards use the Card_Grid pattern with --grid-gap.
// ------------------------------------------------------------

describe("Templates Card_Grid — cards use the Card_Grid pattern (Req 14.2)", () => {
    test("the .grid-container rule uses the repeat(auto-fill, minmax(...)) Card_Grid pattern", () => {
        expect(gridRule).toMatch(/display\s*:\s*grid/);
        expect(gridRule).toMatch(
            /grid-template-columns\s*:\s*repeat\(\s*auto-fill\s*,\s*minmax\(/
        );
    });

    test("the .grid-container gap is driven by the --grid-gap Spacing_Scale token", () => {
        expect(gridRule).toMatch(/gap\s*:\s*var\(\s*--grid-gap/);
    });

    test.each(GRID_CONTAINER_IDS)(
        'grid container "%s" exists and carries the .grid-container class',
        (id) => {
            expect(countId(templatesRegion, id)).toBe(1);
            const tag = openingTagsContaining(templatesRegion, 'id="' + id + '"')[0];
            expect(tag).toBeDefined();
            expect(/class="[^"]*\bgrid-container\b[^"]*"/.test(tag)).toBe(true);
        }
    );
});
