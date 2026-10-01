/**
 * tests/template-hover-preview.test.js
 * Verifies hover preview behavior on template cards across all sections,
 * ensuring event delegation, repeatability, and persistence across VirtualGrid repaints.
 */

const fs = require("fs");
const path = require("path");

describe("Template Card Hover Preview System", function () {
    const textAnimSrc = fs.readFileSync(path.join(__dirname, "../js/textanim/textanim.js"), "utf8");
    const virtualGridSrc = fs.readFileSync(path.join(__dirname, "../js/templates/virtualGrid.js"), "utf8");
    const templateCardViewSrc = fs.readFileSync(path.join(__dirname, "../js/templates/templateCardView.js"), "utf8");
    const templatesSrc = fs.readFileSync(path.join(__dirname, "../js/templates/templates.js"), "utf8");

    test("templateCardView allows hover previews in ALL template sections", function () {
        const CardView = require("../js/templates/templateCardView.js");
        expect(typeof CardView.sectionUsesHoverPreviews).toBe("function");
        expect(CardView.sectionUsesHoverPreviews()).toBe(true);
    });

    test("templates.js sectionUsesHoverPreviews returns true unconditionally", function () {
        expect(templatesSrc).toMatch(/function\s+sectionUsesHoverPreviews\s*\(\)\s*\{\s*return\s+true;\s*\}/);
    });

    test("VirtualGrid stores onPainted and triggers it during metrics settling and scrolling", function () {
        // onPainted must be saved on state
        expect(virtualGridSrc).toContain("state.onPainted = options.onPainted;");

        // settleMetrics must notify onPainted
        expect(virtualGridSrc).toMatch(/if\s*\(changed\s*&&\s*state\s*&&\s*typeof\s*state\.onPainted\s*===\s*"function"/);

        // paintForScroll must notify onPainted
        expect(virtualGridSrc).toMatch(/paintWindow\(state,\s*win\.first,\s*win\.last\);\s*if\s*\(state\s*&&\s*typeof\s*state\.onPainted\s*===\s*"function"/);

        // sync must notify onPainted
        expect(virtualGridSrc).toMatch(/if\s*\(typeof\s*state\.onPainted\s*===\s*"function"\s*&&\s*state\.grid\)/);
    });

    test("TextAnim implements robust event delegation on grid containers", function () {
        // Must contain delegated event listener functions
        expect(textAnimSrc).toContain("function onGridMouseOver");
        expect(textAnimSrc).toContain("function onGridMouseOut");
        expect(textAnimSrc).toContain("function bindGridDelegation");
        expect(textAnimSrc).toContain("function bindAllGridContainers");

        // Must cover all template sub-section grid containers and ta-grid
        expect(textAnimSrc).toContain('"comp-list-container"');
        expect(textAnimSrc).toContain('"transition-list-container"');
        expect(textAnimSrc).toContain('"text-list-container"');
        expect(textAnimSrc).toContain('"footage-list-container"');
        expect(textAnimSrc).toContain('"effect-list-container"');
        expect(textAnimSrc).toContain('"icon-list-container"');
        expect(textAnimSrc).toContain('"ta-grid"');

        // attachHoverPreviews must bind delegation to the grid
        expect(textAnimSrc).toContain("bindGridDelegation(grid);");
        expect(textAnimSrc).toContain("bindAllGridContainers();");

        // Export bindAllGridContainers
        expect(textAnimSrc).toContain("bindAllGridContainers: bindAllGridContainers");
    });

    test("activatePreview and deactivatePreview are idempotent and handle template cards", function () {
        // Prevents redundant re-activation if already previewing
        expect(textAnimSrc).toContain("if (hoverActiveCard === card && container.querySelector(\".ta-card-preview\"))");

        // Prevents redundant deactivation if already clean
        expect(textAnimSrc).toContain("if (!container.querySelector(\".ta-card-preview\") && hoverActiveCard !== card)");

        // Restores thumbnail properly for template cards
        expect(textAnimSrc).toContain("var thumbSrc = card.getAttribute(\"data-thumb\");");
    });
});
