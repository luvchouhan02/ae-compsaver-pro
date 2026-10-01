/**
 * Class Contract / modular-import / DOM-inventory static-analysis tests.
 *
 * Spec: panel-visual-redesign — Task 13.2
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 1.5
 *
 * The redesign is presentation-layer-only: every CSS class name, element id,
 * and data-* attribute the JavaScript depends on must survive. These tests read
 * the source files as text and assert the structural contract still holds.
 *
 * The baseline fixture (tests/fixtures/class-contract.baseline.json) captures the
 * committed state. Removing something the JS relies on fails the test; adding new
 * elements/classes is always allowed.
 *
 * Regenerate the baseline (only when an intentional, reviewed contract change
 * occurs) with:  node tests/helpers/generate-baseline.js
 */

const SA = require("./helpers/static-analysis");
const baseline = require("./fixtures/class-contract.baseline.json");

// The documented, cascade-sensitive module import order (from css/style.css).
const EXPECTED_IMPORT_ORDER = [
    "base",
    "header",
    "toolkit",
    "effects",
    "flow",
    "templates",
    "colorflow",
    "responsive",
    "textanim",
    "layout",
    "polish",
];

// Load all source text once.
const html = SA.composeMarkup();
const styleCss = SA.read("css/style.css");
const allCss = SA.readAllCss();
const allJs = SA.readAllJs();

// Derived "current state" facts.
const currentImports = SA.parseStyleImports(styleCss);
const cssFiles = SA.listCssFiles();
const linkedCss = SA.parseLinkedCss(html);

const htmlIds = SA.extractAllIds(html);
const interactiveIds = SA.extractInteractiveIds(html);
const htmlClasses = SA.extractHtmlClasses(html);
const htmlDataAttrs = SA.extractHtmlDataAttrs(html);

const cssClasses = SA.extractCssClasses(allCss);
const cssDataAttrs = SA.extractCssDataAttrs(allCss);

describe("Modular CSS import architecture (Req 2.4, 2.5)", () => {
    test("style.css imports the nine modules in the documented order", () => {
        expect(currentImports).toEqual(EXPECTED_IMPORT_ORDER);
    });

    test("every css/*.css file is wired through the import architecture", () => {
        // A module file is "wired" if it is the style entry itself, imported by
        // style.css, or linked directly in index.html (settings.css is linked).
        const importedFiles = new Set(currentImports.map((m) => m + ".css"));

        const orphans = cssFiles.filter((file) => {
            if (file === "style.css") return false; // the entry point itself
            if (importedFiles.has(file)) return false; // imported via style.css
            if (linkedCss.has(file)) return false; // <link> in index.html
            return true;
        });

        expect(orphans).toEqual([]);
    });

    test("settings.css is present and linked (not folded away from the architecture)", () => {
        expect(cssFiles).toContain("settings.css");
        expect(linkedCss.has("settings.css")).toBe(true);
    });
});

describe("Class Contract — element ids referenced by JavaScript (Req 2.1, 2.2, 2.3)", () => {
    test("every JS-referenced static id still exists in index.html", () => {
        const missing = baseline.jsStaticIds.filter((id) => !htmlIds.has(id));
        expect(missing).toEqual([]);
    });
});

describe("Class Contract — classes referenced by JavaScript (Req 2.1, 2.3)", () => {
    test("every JS classList class still exists in the HTML and/or has a CSS rule", () => {
        const unresolved = baseline.jsResolvableClasses.filter(
            (cls) => !htmlClasses.has(cls) && !cssClasses.has(cls)
        );
        expect(unresolved).toEqual([]);
    });
});

describe("Class Contract — data-* attributes referenced by JavaScript (Req 2.1)", () => {
    test("every JS-referenced data-* attribute is still authored in HTML and/or used in CSS", () => {
        const unresolved = baseline.jsResolvableDataAttrs.filter(
            (attr) => !htmlDataAttrs.has(attr) && !cssDataAttrs.has(attr)
        );
        expect(unresolved).toEqual([]);
    });
});

describe("DOM inventory — interactive elements of index.html (Req 1.5, 2.1)", () => {
    test("no pre-existing interactive element id has been removed", () => {
        const removed = baseline.interactiveIds.filter(
            (id) => !interactiveIds.has(id)
        );
        expect(removed).toEqual([]);
    });

    test("baseline inventory is non-empty (guards against a broken extractor)", () => {
        expect(baseline.interactiveIds.length).toBeGreaterThan(0);
        expect(interactiveIds.size).toBeGreaterThanOrEqual(
            baseline.interactiveIds.length
        );
    });
});
