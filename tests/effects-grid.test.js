/**
 * Effects Grid & Bulk-Delete State Static-Analysis Tests
 *
 * Spec: panel-layout-redesign — Task 7.2
 * **Validates: Requirements 11.2, 11.5**
 *
 * These tests read css/effects.css as TEXT (Node env, no DOM) and assert the
 * structural guarantees of the Effects view:
 *
 * - 11.2 (Card_Grid pattern): the effects grid (.tk-effects-grid / .fx-grid)
 *   uses `display: grid` with a `repeat(auto-fill, minmax(...))` column
 *   template and a `gap` drawn from the `--grid-gap` token, so cards adopt
 *   uniform dimensions and align into consistent columns with equal spacing.
 *
 * - 11.5 (bulk-delete treatment): while bulk-delete mode is active, the grid
 *   takes a destructive treatment (.bulk-mode / .has-selection) and each
 *   selected card (.selected-for-delete) takes a treatment that is visually
 *   DISTINCT from the unselected card rule (different border / background /
 *   color declarations).
 *
 * Pure text parsing keeps the tests deterministic and DOM-free, matching the
 * conventions of the other static-analysis suites in tests/.
 */

const fs = require("fs");
const path = require("path");

const EFFECTS_CSS_PATH = path.join(__dirname, "..", "css", "effects.css");

// ────────────────────────────────────────────────────────────────────────
// Helpers — parse effects.css as text and pull out specific rule blocks.
// ────────────────────────────────────────────────────────────────────────

/** Read css/effects.css from disk as a UTF-8 string. */
function readEffectsCss() {
    return fs.readFileSync(EFFECTS_CSS_PATH, "utf8");
}

/** Strip CSS block comments so selectors inside comments are not matched. */
function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Find the declaration block (between braces) of the FIRST rule whose selector
 * list contains the given exact selector token. Uses brace-depth counting so a
 * declaration value containing braces would still be handled robustly.
 *
 * @param {string} css   comment-stripped stylesheet text
 * @param {string} selector  e.g. ".tk-effects-grid" or ".tk-effect-card.selected-for-delete"
 * @returns {string|null} the block contents, or null if no rule matches
 */
function findRuleBlock(css, selector) {
    // Escape regex metacharacters in the selector (dots, etc.).
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match the selector as a whole token in a selector list: it must be
    // preceded by start/comma/brace/whitespace and followed by a boundary
    // (comma, brace, whitespace, combinator) — NOT by an extra class/word char,
    // so ".tk-effect-card" does not match ".tk-effect-card.selected-for-delete".
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

// Parse once, share across the suites.
const cleanCss = stripComments(readEffectsCss());

// ────────────────────────────────────────────────────────────────────────
// Requirement 11.2 — Card_Grid pattern on the effects grid
// ────────────────────────────────────────────────────────────────────────
describe("Effects grid uses the Card_Grid pattern (Requirement 11.2)", () => {
    // The grid rule is authored as a shared selector list: .tk-effects-grid, .fx-grid
    const gridBlock = findRuleBlock(cleanCss, ".tk-effects-grid");

    test("a rule for the effects grid (.tk-effects-grid / .fx-grid) exists", () => {
        expect(gridBlock).not.toBeNull();
        // The same rule must cover the .fx-grid alias too.
        expect(findRuleBlock(cleanCss, ".fx-grid")).not.toBeNull();
    });

    test("the grid declares display: grid", () => {
        const decls = parseDeclarations(gridBlock);
        // value may carry !important — normalize before comparing.
        const display = decls["display"].replace(/!important/i, "").trim();
        expect(display).toBe("grid");
    });

    test("grid-template-columns uses repeat(auto-fill, minmax(...)) (Card_Grid formula)", () => {
        const decls = parseDeclarations(gridBlock);
        const cols = decls["grid-template-columns"];
        expect(cols).toBeDefined();
        // The auto-fill + minmax formula is what makes the column count derive
        // from width (Req 12.5) and gives uniform columns (Req 11.2).
        expect(cols).toMatch(/repeat\(\s*auto-fill\s*,\s*minmax\(/i);
    });

    test("the column min uses the --grid-min-col token", () => {
        const decls = parseDeclarations(gridBlock);
        expect(decls["grid-template-columns"]).toMatch(/--grid-min-col/);
    });

    test("gap is drawn from the --grid-gap token (equal spacing between cards)", () => {
        const decls = parseDeclarations(gridBlock);
        expect(decls["gap"]).toBeDefined();
        expect(decls["gap"]).toMatch(/var\(\s*--grid-gap/);
    });
});

// ────────────────────────────────────────────────────────────────────────
// Requirement 11.5 — bulk-delete destructive treatment + distinct selection
// ────────────────────────────────────────────────────────────────────────
describe("Bulk-delete mode treatment (Requirement 11.5)", () => {
    const gridBulkBlock = findRuleBlock(cleanCss, ".tk-effects-grid.bulk-mode");
    const gridSelectionBlock = findRuleBlock(
        cleanCss,
        ".tk-effects-grid.has-selection"
    );
    const unselectedBlock = findRuleBlock(cleanCss, ".tk-effect-card");
    const selectedBlock = findRuleBlock(
        cleanCss,
        ".tk-effect-card.selected-for-delete"
    );

    test("the grid takes a destructive treatment in bulk/selection mode", () => {
        // Authored as a combined list:
        //   .tk-effects-grid.bulk-mode, .fx-grid.bulk-mode,
        //   .tk-effects-grid.has-selection, .fx-grid.has-selection { ... }
        // Either combined-selector token resolves to the same block.
        const block = gridBulkBlock || gridSelectionBlock;
        expect(block).not.toBeNull();
        const decls = parseDeclarations(block);
        // A danger hairline distinguishes the grid in destructive mode.
        expect(decls["border-color"]).toMatch(/--danger/);
    });

    test("a .selected-for-delete card rule exists and uses the danger palette", () => {
        expect(selectedBlock).not.toBeNull();
        const decls = parseDeclarations(selectedBlock);
        expect(decls["border-color"]).toMatch(/--danger/);
        expect(decls["background"]).toMatch(/--danger/);
        expect(decls["color"]).toMatch(/--danger/);
    });

    test("the unselected card rule does NOT use the danger palette (baseline)", () => {
        expect(unselectedBlock).not.toBeNull();
        const decls = parseDeclarations(unselectedBlock);
        // The base .tk-effect-card uses neutral surface/line tokens, not danger.
        expect(decls["border-color"] || "").not.toMatch(/--danger/);
        expect(decls["background"] || "").not.toMatch(/--danger/);
        expect(decls["color"] || "").not.toMatch(/--danger/);
    });

    test("selected-for-delete is VISUALLY DISTINCT from the unselected card", () => {
        const selected = parseDeclarations(selectedBlock);
        const unselected = parseDeclarations(unselectedBlock);

        // At least one of border/background/color must differ between the two
        // rules — proving the selected-state treatment is distinguishable.
        const differs =
            selected["border-color"] !== unselected["border-color"] ||
            selected["background"] !== unselected["background"] ||
            selected["color"] !== unselected["color"];

        expect(differs).toBe(true);
    });
});
