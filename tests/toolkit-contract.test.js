/**
 * Toolkit `data-toolkit-action` / `data-mode` binding contract test.
 *
 * Spec: panel-layout-redesign — Task 6.2
 * Requirements: 3.1, 3.3, 10.4
 *
 * The Toolkit Tools view was restructured inside #toolkit-tools-view of
 * index.html. The toolkit JS (js/toolkit/toolkit.js) drives every workbench
 * button through two data-* bindings: it selects `[data-toolkit-action]`
 * elements and, on click, dispatches `runToolkitAction(el.dataset.toolkitAction,
 * el.dataset.mode, ...)`. Requirement 10.4 requires that anchor/create/precomp/
 * align/fast-access/timing click behavior is preserved through that Class_Contract;
 * Requirements 3.1 / 3.3 require the contract selectors to resolve in the
 * restructured markup with zero stale references.
 *
 * This test reads index.html and js/toolkit/toolkit.js as TEXT (no DOM, no
 * bundler), so it stays deterministic under jest's "node" testEnvironment. The
 * real binding values are derived from the sources — nothing is hardcoded:
 *   - the set of action values the JS actually handles is parsed from
 *     runToolkitAction's `action === "..."` dispatch + SILENT_SUCCESS_ACTIONS.
 *   - the action/mode values present in the markup are parsed from the
 *     restructured Toolkit region.
 *
 * The contract asserted:
 *   A. Every `data-toolkit-action` value authored in the Toolkit markup resolves
 *      to a handler in runToolkitAction (no dead/stale binding).  [Req 3.3, 10.4]
 *   B. Every element carrying `data-mode` also carries `data-toolkit-action`, so
 *      the mode parameter resolves to a dispatching binding.       [Req 3.1, 10.4]
 *   C. The data-* attributes the JS reads (data-toolkit-action / data-mode) are
 *      authored in the markup and the `[data-toolkit-action]` selector resolves
 *      to at least one element.                                     [Req 3.1]
 *   D. The Toolkit section switcher renders exactly one `.active` section tab,
 *      and each section tab's data-target resolves to exactly one view element.
 *      The switcher markup lives in the app sidebar (#sidebar-tk-switcher) since
 *      the LAB.PRO redesign, while its data-targets still address .tk-view
 *      sections inside the Toolkit module — so it is located document-wide and
 *      its targets are resolved against the Toolkit region.
 */

const SA = require("./helpers/static-analysis");

// ------------------------------------------------------------
// Source text + Toolkit region bounds
// ------------------------------------------------------------

const html = SA.composeMarkup();
const toolkitJs = SA.read("js/toolkit/toolkit.js");

// The Toolkit module is delimited by these two top-level section comments.
const TK_START = "<!-- ========== TOOLKIT MODULE ========== -->";
const TK_END = "<!-- ========== SETTINGS MODULE ========== -->";

const tkStart = html.indexOf(TK_START);
const tkEnd = html.indexOf(TK_END);
const toolkitRegion =
    tkStart !== -1 && tkEnd !== -1 ? html.slice(tkStart, tkEnd) : "";

// The section switcher itself lives in the APP SIDEBAR (#sidebar-tk-switcher),
// i.e. OUTSIDE the Toolkit module block, while every tab's data-target still
// addresses a .tk-view inside that block. Locate it document-wide and bound it by
// the container's own closing tag, so the data-target resolution check only
// considers section tabs (other .flow-target-btn buttons also use data-target).
const switcherStart = html.indexOf('class="tk-section-switcher"');
const switcherEnd =
    switcherStart !== -1 ? html.indexOf("</div>", switcherStart) : -1;
const switcherRegion =
    switcherStart !== -1 && switcherEnd !== -1
        ? html.slice(switcherStart, switcherEnd)
        : "";

// ------------------------------------------------------------
// Parsing helpers (pure text analysis)
// ------------------------------------------------------------

/** Every value of a given attribute (e.g. data-mode) authored in a blob. */
function attrValues(htmlText, attr) {
    const re = new RegExp(attr + '="([^"]*)"', "g");
    const out = [];
    let m;
    while ((m = re.exec(htmlText)) !== null) out.push(m[1]);
    return out;
}

/** Distinct set of an attribute's values. */
function attrValueSet(htmlText, attr) {
    return new Set(attrValues(htmlText, attr));
}

/** Collect every opening tag whose text contains `substr`. */
function openingTagsContaining(htmlText, substr) {
    const tagRe = /<[a-zA-Z][^>]*>/g; // [^>] matches newlines, so multi-line tags are caught
    const out = [];
    let m;
    while ((m = tagRe.exec(htmlText)) !== null) {
        if (m[0].indexOf(substr) !== -1) out.push(m[0]);
    }
    return out;
}

/** Count how many elements carry id="value". */
function countId(htmlText, id) {
    const re = new RegExp('\\bid="' + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"', "g");
    const m = htmlText.match(re);
    return m ? m.length : 0;
}

/**
 * The set of action values runToolkitAction actually handles, parsed from the
 * `action === "..."` dispatch branches and the SILENT_SUCCESS_ACTIONS map. This
 * is the JS-side source of truth for "what data-toolkit-action values resolve to
 * a behavior".
 */
function extractHandledActions(jsText) {
    const set = new Set();
    let m;

    const dispatchRe = /action\s*===\s*"([^"]+)"/g;
    while ((m = dispatchRe.exec(jsText)) !== null) set.add(m[1]);

    const objMatch = jsText.match(/SILENT_SUCCESS_ACTIONS\s*=\s*\{([^}]*)\}/);
    if (objMatch) {
        const keyRe = /(?:"([^"]+)"|([A-Za-z_][\w-]*))\s*:/g;
        let k;
        while ((k = keyRe.exec(objMatch[1])) !== null) set.add(k[1] || k[2]);
    }
    return set;
}

// ------------------------------------------------------------
// Derived facts
// ------------------------------------------------------------

const handledActions = extractHandledActions(toolkitJs);
const markupActions = attrValueSet(toolkitRegion, "data-toolkit-action");
const markupModes = attrValues(toolkitRegion, "data-mode");

// Does the JS actually read these datasets? (confirms the bindings are live.)
const jsReadsToolkitAction = /\.dataset\.toolkitAction/.test(toolkitJs);
const jsReadsMode = /\.dataset\.mode/.test(toolkitJs);
const jsSelectsToolkitAction = /querySelectorAll\(\s*["'`]\[data-toolkit-action\]["'`]/.test(
    toolkitJs
);

// ------------------------------------------------------------
// Sanity: regions and JS wiring were located.
// ------------------------------------------------------------

describe("Toolkit region extraction", () => {
    test("the Toolkit module block is present and bounded in index.html", () => {
        expect(tkStart).toBeGreaterThan(-1);
        expect(tkEnd).toBeGreaterThan(tkStart);
        expect(toolkitRegion).toContain('id="toolkit-tools-view"');
    });

    test("the Toolkit section switcher is present and bounded in index.html", () => {
        expect(switcherStart).toBeGreaterThan(-1);
        expect(switcherEnd).toBeGreaterThan(switcherStart);
        expect(switcherRegion).toContain("tk-section-btn");
    });

    test("the JS exposes a non-empty runToolkitAction handler set", () => {
        expect(handledActions.size).toBeGreaterThan(0);
        // Spot-check a couple of canonical handlers are parsed correctly.
        expect(handledActions.has("anchor")).toBe(true);
        expect(handledActions.has("align")).toBe(true);
    });
});

// ------------------------------------------------------------
// C. The data-* attributes the JS reads are authored in the markup. (Req 3.1)
// ------------------------------------------------------------

describe("Toolkit binding surface — JS-read data-* attributes resolve to markup (Req 3.1)", () => {
    test("the toolkit JS reads dataset.toolkitAction and dataset.mode", () => {
        expect(jsReadsToolkitAction).toBe(true);
        expect(jsReadsMode).toBe(true);
    });

    test("the JS [data-toolkit-action] selector resolves to at least one markup element", () => {
        expect(jsSelectsToolkitAction).toBe(true);
        expect(markupActions.size).toBeGreaterThan(0);
        expect(attrValues(toolkitRegion, "data-toolkit-action").length).toBeGreaterThan(0);
    });

    test("the data-mode attribute the JS reads is authored on at least one element", () => {
        expect(markupModes.length).toBeGreaterThan(0);
    });
});

// ------------------------------------------------------------
// A. Every data-toolkit-action value in markup resolves to a JS handler.
//    (Req 3.3 — zero stale references; Req 10.4 — click behavior preserved)
// ------------------------------------------------------------

describe("Toolkit data-toolkit-action bindings resolve to a handler (Req 3.3, 10.4)", () => {
    test.each([...markupActions])(
        'data-toolkit-action "%s" resolves to a runToolkitAction handler',
        (action) => {
            expect(handledActions.has(action)).toBe(true);
        }
    );

    test("no data-toolkit-action value in the markup is an unhandled (dead) binding", () => {
        const dead = [...markupActions].filter((a) => !handledActions.has(a));
        expect(dead).toEqual([]);
    });
});

// ------------------------------------------------------------
// B. Every data-mode value resolves to a dispatching binding. (Req 3.1, 10.4)
//    A data-mode is only meaningful when read alongside a data-toolkit-action,
//    so every element carrying data-mode must also carry data-toolkit-action.
// ------------------------------------------------------------

describe("Toolkit data-mode values resolve to a dispatching binding (Req 3.1, 10.4)", () => {
    test("every element with data-mode also carries data-toolkit-action", () => {
        const modeTags = openingTagsContaining(toolkitRegion, "data-mode=");
        const orphans = modeTags.filter(
            (tag) => tag.indexOf("data-toolkit-action=") === -1
        );
        expect(orphans).toEqual([]);
    });

    test("no data-mode value is empty", () => {
        const empties = markupModes.filter((v) => v.trim() === "");
        expect(empties).toEqual([]);
    });
});

// ------------------------------------------------------------
// D. Toolkit section switcher: exactly one active tab, data-targets resolve.
//    (assertion goal; Req 3.1 — switcher selectors resolve to one element)
// ------------------------------------------------------------

describe("Toolkit section switcher — exactly one active tab (Req 3.1)", () => {
    test("the switcher renders multiple section tabs with exactly one .active", () => {
        const tabTags = openingTagsContaining(switcherRegion, "tk-section-btn");
        const totalTabs = tabTags.length;
        const activeTabs = tabTags.filter((tag) =>
            /class="[^"]*\btk-section-btn\b[^"]*\bactive\b[^"]*"/.test(tag)
        ).length;

        expect(totalTabs).toBeGreaterThanOrEqual(2);
        expect(activeTabs).toBe(1);
    });

    test("each section tab's data-target resolves to exactly one view element", () => {
        const targets = attrValues(switcherRegion, "data-target");
        expect(targets.length).toBeGreaterThanOrEqual(2);
        const unresolved = targets.filter((id) => countId(toolkitRegion, id) !== 1);
        expect(unresolved).toEqual([]);
    });

    test("exactly one .tk-view section renders active by default", () => {
        const viewTags = openingTagsContaining(toolkitRegion, "tk-view");
        const activeViews = viewTags.filter((tag) =>
            /class="[^"]*\btk-view\b[^"]*\bactive\b[^"]*"/.test(tag)
        );
        expect(activeViews.length).toBe(1);
    });
});
