/**
 * TextAnim Layout — stack order & Card_Grid wrapping static-analysis tests.
 *
 * Spec: panel-layout-redesign — Task 9.2
 * **Validates: Requirements 13.1, 13.2, 13.3**
 *
 * The Text Animation view was restructured (Task 9.1) into a single vertical
 * stack — toolbar, then category bar, then the text-animation card grid — with
 * the cards laid out using the Component_System Card_Grid pattern. These tests
 * read the SOURCE FILES AS TEXT (no DOM, no bundler), matching the convention
 * of the other static-analysis suites (tests/effects-grid.test.js parses CSS
 * grid rules; tests/header-contract.test.js parses index.html markup order):
 *
 * - 13.1 (vertical stack order): within #toolkit-text-anim-view the toolbar
 *   region (.ta-toolbar) appears first, the category bar (.tk-category-bar-wrap)
 *   second, and the card grid region (.ta-grid-wrap / .ta-grid) third in DOM
 *   order, and each spans the full content width.
 *
 * - 13.2 (Card_Grid pattern): the card grid (.ta-grid) uses `display: grid` with
 *   a `repeat(auto-fill, minmax(...))` column template and a `gap` drawn from the
 *   `--grid-gap` token, so cards fill the width into uniform columns.
 *
 * - 13.3 (wrap without horizontal overflow): the auto-fill column template wraps
 *   remaining cards onto new rows, and no rule forces horizontal overflow on the
 *   grid region (the scroll wrapper pins overflow-x: hidden; the grid does not
 *   opt into horizontal scroll or a column-flow that would expand sideways).
 *
 * Pure text parsing keeps these deterministic and DOM-free under jest's "node"
 * testEnvironment.
 */

const fs = require("fs");
const path = require("path");
const SA = require("./helpers/static-analysis");

const ROOT = path.resolve(__dirname, "..");
const TEXTANIM_CSS_PATH = path.join(ROOT, "css", "textanim.css");

// ────────────────────────────────────────────────────────────────────────
// Helpers — parse CSS text and pull out specific rule blocks.
// (Mirrors the approach used in tests/effects-grid.test.js.)
// ────────────────────────────────────────────────────────────────────────

/** Strip CSS block comments so selectors inside comments are not matched. */
function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Find the declaration block (between braces) of the FIRST rule whose selector
 * list contains the given exact selector token. Brace-depth counting keeps it
 * robust against values that contain braces.
 *
 * @param {string} css   comment-stripped stylesheet text
 * @param {string} selector  e.g. ".ta-grid"
 * @returns {string|null} the block contents, or null if no rule matches
 */
function findRuleBlock(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The selector must be a whole token in a selector list: preceded by
    // start/comma/brace/whitespace and NOT followed by an extra class/word char,
    // so ".ta-grid" does not match ".ta-grid-wrap" or ".ta-grid.bulk-mode".
    const re = new RegExp(
        "(?:^|[,{}\\s])" + escaped + "(?![\\w-])[^{};]*\\{",
        "g"
    );
    const m = re.exec(css);
    if (!m) return null;

    const openIdx = css.indexOf("{", m.index);
    if (openIdx === -1) return null;

    let depth = 0;
    for (let i = openIdx; i < css.length; i++) {
        const ch = css[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) return css.slice(openIdx + 1, i);
        }
    }
    return null;
}

/**
 * Parse `prop: value;` declarations from a rule block into a lowercased map.
 * The last declaration of a duplicated property wins (cascade within a rule).
 */
function parseDeclarations(block) {
    const map = {};
    const re = /([a-z-]+)\s*:\s*([^;]+);/gi;
    let m;
    while ((m = re.exec(block)) !== null) {
        map[m[1].toLowerCase().trim()] = m[2].trim();
    }
    return map;
}

// Parse the stylesheets / markup once, share across the suites.
const cleanCss = stripComments(fs.readFileSync(TEXTANIM_CSS_PATH, "utf8"));
const html = SA.composeMarkup();

// The TextAnim view is delimited by these top-level section comments in
// index.html (the view block followed by the SETTINGS MODULE section).
const VIEW_START = "<!-- ========== TEXT ANIMATION VIEW (nested inside Toolkit) ========== -->";
const VIEW_END = "<!-- ========== SETTINGS MODULE ========== -->";

const startIdx = html.indexOf(VIEW_START);
const endIdx = html.indexOf(VIEW_END);
const viewRegion =
    startIdx !== -1 && endIdx !== -1 ? html.slice(startIdx, endIdx) : "";

// ────────────────────────────────────────────────────────────────────────
// Sanity: the TextAnim view region was located.
// ────────────────────────────────────────────────────────────────────────
describe("TextAnim view region extraction", () => {
    test("the Text Animation view block is present and bounded in index.html", () => {
        expect(startIdx).toBeGreaterThan(-1);
        expect(endIdx).toBeGreaterThan(startIdx);
        expect(viewRegion).toContain('id="toolkit-text-anim-view"');
    });
});

// ────────────────────────────────────────────────────────────────────────
// Requirement 13.1 — single vertical stack: toolbar → category bar → card grid
// ────────────────────────────────────────────────────────────────────────
describe("TextAnim vertical stack order (Requirement 13.1)", () => {
    const toolbarIdx = viewRegion.indexOf('class="ta-toolbar"');
    const categoryBarIdx = viewRegion.indexOf('class="tk-category-bar-wrap"');
    const gridWrapIdx = viewRegion.indexOf('class="ta-grid-wrap"');
    const gridIdx = viewRegion.indexOf('class="ta-grid"');

    test("the toolbar, category bar, and card-grid regions are all present in the view", () => {
        expect(toolbarIdx).toBeGreaterThan(-1);
        expect(categoryBarIdx).toBeGreaterThan(-1);
        expect(gridWrapIdx).toBeGreaterThan(-1);
        expect(gridIdx).toBeGreaterThan(-1);
    });

    test("toolbar appears FIRST (before the category bar)", () => {
        expect(toolbarIdx).toBeLessThan(categoryBarIdx);
    });

    test("category bar appears SECOND (between toolbar and card grid)", () => {
        expect(categoryBarIdx).toBeGreaterThan(toolbarIdx);
        expect(categoryBarIdx).toBeLessThan(gridWrapIdx);
    });

    test("card grid appears THIRD (after the category bar)", () => {
        expect(gridWrapIdx).toBeGreaterThan(categoryBarIdx);
        // The grid itself is nested inside the scroll wrapper.
        expect(gridIdx).toBeGreaterThan(gridWrapIdx);
    });

    test("the view is a vertical flex column so the regions stack top-to-bottom", () => {
        const viewBlock = findRuleBlock(cleanCss, "#toolkit-text-anim-view");
        expect(viewBlock).not.toBeNull();
        const decls = parseDeclarations(viewBlock);
        expect(decls["display"]).toBe("flex");
        expect(decls["flex-direction"]).toBe("column");
    });

    test("the toolbar and card grid each span the full content width (Req 13.1)", () => {
        const toolbarBlock = findRuleBlock(cleanCss, ".ta-toolbar");
        const gridBlock = findRuleBlock(cleanCss, ".ta-grid");
        expect(toolbarBlock).not.toBeNull();
        expect(gridBlock).not.toBeNull();
        expect(parseDeclarations(toolbarBlock)["width"]).toBe("100%");
        expect(parseDeclarations(gridBlock)["width"]).toBe("100%");
    });
});

// ────────────────────────────────────────────────────────────────────────
// Requirement 13.2 — card grid uses the Card_Grid pattern
// ────────────────────────────────────────────────────────────────────────
describe("TextAnim card grid uses the Card_Grid pattern (Requirement 13.2)", () => {
    const gridBlock = findRuleBlock(cleanCss, ".ta-grid");

    test("a rule for the card grid (.ta-grid) exists", () => {
        expect(gridBlock).not.toBeNull();
    });

    test("the grid declares display: grid", () => {
        const decls = parseDeclarations(gridBlock);
        const display = (decls["display"] || "").replace(/!important/i, "").trim();
        expect(display).toBe("grid");
    });

    test("grid-template-columns uses repeat(auto-fill, minmax(...)) (Card_Grid formula)", () => {
        const decls = parseDeclarations(gridBlock);
        const cols = decls["grid-template-columns"];
        expect(cols).toBeDefined();
        // auto-fill + minmax derives the column count from width (≥1, non-decreasing)
        // and gives uniform columns that fill the row.
        expect(cols).toMatch(/repeat\(\s*auto-fill\s*,\s*minmax\(/i);
    });

    test("gap is drawn from the --grid-gap token (equal spacing between cards)", () => {
        const decls = parseDeclarations(gridBlock);
        expect(decls["gap"]).toBeDefined();
        expect(decls["gap"]).toMatch(/var\(\s*--grid-gap/);
    });
});

// ────────────────────────────────────────────────────────────────────────
// Requirement 13.3 — wrap onto new rows with NO forced horizontal overflow
// ────────────────────────────────────────────────────────────────────────
describe("TextAnim card grid wraps without horizontal overflow (Requirement 13.3)", () => {
    const gridBlock = findRuleBlock(cleanCss, ".ta-grid");
    const gridWrapBlock = findRuleBlock(cleanCss, ".ta-grid-wrap");

    test("the auto-fill column template is what wraps cards onto new rows", () => {
        // auto-fill (vs auto-fit) keeps wrapping behavior: when cards exceed a row
        // the column count is fixed by width and extras flow to the next row.
        const cols = parseDeclarations(gridBlock)["grid-template-columns"];
        expect(cols).toMatch(/auto-fill/i);
    });

    test("the grid does NOT use a column auto-flow that would expand sideways", () => {
        const decls = parseDeclarations(gridBlock);
        const flow = (decls["grid-auto-flow"] || "row").toLowerCase();
        // grid-auto-flow: column would lay cards into ever-growing columns
        // (horizontal growth). Default row-flow wraps downward.
        expect(flow).not.toMatch(/column/);
    });

    test("the grid does NOT opt into horizontal scroll/overflow", () => {
        const decls = parseDeclarations(gridBlock);
        const overflowX = (decls["overflow-x"] || "").toLowerCase();
        const overflow = (decls["overflow"] || "").toLowerCase();
        expect(overflowX).not.toMatch(/scroll|auto/);
        expect(overflow).not.toMatch(/scroll|auto/);
        // box-sizing: border-box + width:100% keeps the grid inside its column.
        expect(decls["box-sizing"]).toBe("border-box");
    });

    test("the scroll wrapper (.ta-grid-wrap) pins overflow-x: hidden (no sideways scrollbar)", () => {
        expect(gridWrapBlock).not.toBeNull();
        const decls = parseDeclarations(gridWrapBlock);
        expect((decls["overflow-x"] || "").toLowerCase()).toBe("hidden");
    });
});
