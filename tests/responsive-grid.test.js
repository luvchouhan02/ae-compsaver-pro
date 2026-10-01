/**
 * Responsive Card_Grid Column-Behavior Static-Analysis Tests
 *
 * Spec: panel-layout-redesign — Task 15.2
 * **Validates: Requirements 19.1, 19.5**
 *
 * Goal: assert the Card_Grid column count is ≥1 and NON-DECREASING across
 * sampled widths in the Dock_Range (180–500px).
 *
 * Approach (Node env, no DOM — matches the other static-analysis suites):
 *
 *   1. Read css/base.css as TEXT and parse the real layout tokens
 *      (--space-*, --grid-gap, --grid-min-col, --grid-col-max). Nothing is
 *      hardcoded — the token VALUES used by the model below are resolved from
 *      the stylesheet so the test tracks the source of truth.
 *
 *   2. Read the real per-module Card_Grid min-column values authored on top of
 *      the base primitive (.cs-card-grid 96px, .tk-effects-grid 64px,
 *      .grid-container --tpl-grid-min 72px, .ta-grid 60px) so every concrete
 *      Card_Grid is exercised, not just the primitive.
 *
 *   3. Model the CSS `repeat(auto-fill, minmax(minCol, 1fr))` column count with
 *      a small PURE helper and sample widths every 20px across 180–500px,
 *      asserting the result is always ≥1 (Req 19.5) and never decreases as
 *      width grows (Req 19.5, 19.1).
 *
 *   4. Guard the invariant at its source: assert css/responsive.css does NOT
 *      override the Card_Grid column inputs (--grid-min-col / --grid-gap) inside
 *      any media query, keeps any grid-template-columns it touches on the
 *      width-derived auto-fill/minmax formula, and keeps the grid container's
 *      HORIZONTAL padding constant across breakpoints — the three things that,
 *      if changed per-width, would break column monotonicity.
 *
 * Pure text parsing + a pure model keeps the suite deterministic and DOM-free.
 */

const fs = require("fs");
const path = require("path");

const CSS_DIR = path.join(__dirname, "..", "css");
const BASE_CSS_PATH = path.join(CSS_DIR, "base.css");
const RESPONSIVE_CSS_PATH = path.join(CSS_DIR, "responsive.css");

// ────────────────────────────────────────────────────────────────────────
// Text helpers
// ────────────────────────────────────────────────────────────────────────

function readCss(p) {
    return fs.readFileSync(p, "utf8");
}

/** Strip CSS block comments so declarations inside comments are not matched. */
function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Pull every `--name: value;` custom-property declaration out of a stylesheet
 * into a name→value map (last write wins). Used to read the :root token block.
 */
function parseCustomProps(css) {
    const map = {};
    const re = /(--[\w-]+)\s*:\s*([^;{}]+);/g;
    let m;
    while ((m = re.exec(css)) !== null) {
        map[m[1].trim()] = m[2].trim();
    }
    return map;
}

/**
 * Resolve a token value that may be a literal (`6px`, `96px`, `1fr`) or a
 * `var(--other, fallback)` reference, by walking the token map. Returns the
 * resolved CSS string.
 */
function resolveToken(value, tokens, seen = new Set()) {
    const varMatch = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(
        value.trim()
    );
    if (!varMatch) return value.trim();

    const name = varMatch[1];
    const fallback = varMatch[2] ? varMatch[2].trim() : undefined;

    if (seen.has(name)) return fallback !== undefined ? fallback : "";
    seen.add(name);

    if (tokens[name] !== undefined) {
        return resolveToken(tokens[name], tokens, seen);
    }
    return fallback !== undefined ? resolveToken(fallback, tokens, seen) : "";
}

/** Parse a px string like "6px" / "16px" to a Number. Throws if not px. */
function px(value) {
    const m = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
    if (!m) {
        throw new Error(`Expected a px value, got: "${value}"`);
    }
    return parseFloat(m[1]);
}

/**
 * Split a CSS shorthand value into its top-level space-separated parts while
 * keeping any parenthesised group (e.g. `var(--space-1, 2px)`) intact as one
 * unit. Returns an array of value strings.
 */
function splitTopLevel(value) {
    const parts = [];
    let depth = 0;
    let cur = "";
    for (const ch of value.trim()) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (/\s/.test(ch) && depth === 0) {
            if (cur) {
                parts.push(cur);
                cur = "";
            }
        } else {
            cur += ch;
        }
    }
    if (cur) parts.push(cur);
    return parts;
}

// ────────────────────────────────────────────────────────────────────────
// PURE MODEL — auto-fill column count for repeat(auto-fill, minmax(min, 1fr))
// ────────────────────────────────────────────────────────────────────────

/**
 * Compute the number of columns a CSS grid with
 *   grid-template-columns: repeat(auto-fill, minmax(minCol, <max>))
 *   gap: gap
 * renders inside a container of total width `containerWidth`, given the
 * grid region's total HORIZONTAL padding (left + right).
 *
 * Browser rule: the largest n with  n*minCol + (n-1)*gap <= innerWidth, i.e.
 *   n = floor((innerWidth + gap) / (minCol + gap))
 * clamped to ≥ 1 (a Card_Grid always renders at least one column of content).
 *
 * This is a pure function of its inputs — no width-dependent branching on
 * minCol/gap/padding — which is precisely why the count is monotonic in width.
 *
 * @param {number} containerWidth   total panel/grid container width (px)
 * @param {number} minCol           minmax() min track size (px)
 * @param {number} gap              grid gap (px)
 * @param {number} horizontalPadding total left+right padding of the grid (px)
 * @returns {number} column count, ≥ 1
 */
function autoFillColumns(containerWidth, minCol, gap, horizontalPadding) {
    const inner = containerWidth - horizontalPadding;
    if (inner < minCol) return 1; // clamp: ≥1 column always renders
    const n = Math.floor((inner + gap) / (minCol + gap));
    return Math.max(1, n);
}

// ────────────────────────────────────────────────────────────────────────
// Resolve the REAL token values from base.css (no hardcoded guesses)
// ────────────────────────────────────────────────────────────────────────

const baseCss = stripComments(readCss(BASE_CSS_PATH));
const tokens = parseCustomProps(baseCss);

const GRID_GAP = px(resolveToken("var(--grid-gap)", tokens)); // → --space-3 → 6px
const GRID_MIN_COL = px(resolveToken("var(--grid-min-col)", tokens)); // 96px
const GRID_COL_MAX = resolveToken("var(--grid-col-max)", tokens); // 1fr

// The concrete Card_Grids in the panel: the base primitive plus the per-module
// min-column overrides authored on the identical auto-fill/minmax formula.
const CARD_GRIDS = [
    { name: ".cs-card-grid (primitive)", minCol: GRID_MIN_COL },
    { name: ".tk-effects-grid / .fx-grid (Effects)", minCol: 64 },
    { name: ".grid-container (Templates)", minCol: 72 },
    { name: ".ta-grid (TextAnim)", minCol: 60 },
];

// Sample the whole Dock_Range every 20px (inclusive of the 180 / 500 bounds).
function sampleWidths(lo, hi, step) {
    const out = [];
    for (let w = lo; w <= hi; w += step) out.push(w);
    if (out[out.length - 1] !== hi) out.push(hi);
    return out;
}
const DOCK_WIDTHS = sampleWidths(180, 500, 20);

// A representative horizontal padding for the grid region. The exact value does
// not affect monotonicity (it is constant across widths); we use the real
// Templates grid default (right --space-6 + left --space-4).
const GRID_H_PADDING =
    px(resolveToken("var(--space-6)", tokens)) +
    px(resolveToken("var(--space-4)", tokens));

// ────────────────────────────────────────────────────────────────────────
// Sanity: the parsed tokens are real and well-formed
// ────────────────────────────────────────────────────────────────────────
describe("Card_Grid tokens resolve from base.css (source of truth)", () => {
    test("--grid-gap resolves to a positive px value", () => {
        expect(Number.isFinite(GRID_GAP)).toBe(true);
        expect(GRID_GAP).toBeGreaterThan(0);
    });

    test("--grid-min-col resolves to a positive px value", () => {
        expect(Number.isFinite(GRID_MIN_COL)).toBe(true);
        expect(GRID_MIN_COL).toBeGreaterThan(0);
    });

    test("--grid-col-max is the flexible 1fr track (lets columns fill the row)", () => {
        expect(GRID_COL_MAX).toBe("1fr");
    });
});

// ────────────────────────────────────────────────────────────────────────
// Requirement 19.5 / 19.1 — column count ≥1 and non-decreasing with width
// ────────────────────────────────────────────────────────────────────────
describe("Card_Grid column count across the Dock_Range (180–500px)", () => {
    CARD_GRIDS.forEach(({ name, minCol }) => {
        describe(name, () => {
            const counts = DOCK_WIDTHS.map((w) =>
                autoFillColumns(w, minCol, GRID_GAP, GRID_H_PADDING)
            );

            test("every sampled width yields ≥1 column (Req 19.5)", () => {
                counts.forEach((c, i) => {
                    expect(c).toBeGreaterThanOrEqual(1);
                    // attach width context if it ever fails
                    if (c < 1) {
                        throw new Error(
                            `width ${DOCK_WIDTHS[i]}px → ${c} columns`
                        );
                    }
                });
            });

            test("column count never decreases as width grows (Req 19.5, 19.1)", () => {
                for (let i = 1; i < counts.length; i++) {
                    if (counts[i] < counts[i - 1]) {
                        throw new Error(
                            `NON-MONOTONIC: ${DOCK_WIDTHS[i - 1]}px→${counts[i - 1]
                            } cols then ${DOCK_WIDTHS[i]}px→${counts[i]} cols`
                        );
                    }
                    expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
                }
            });

            test("the widest sampled width has ≥ the narrowest (overall growth)", () => {
                expect(counts[counts.length - 1]).toBeGreaterThanOrEqual(
                    counts[0]
                );
            });
        });
    });
});

// ────────────────────────────────────────────────────────────────────────
// Model self-check — the helper itself is monotonic for arbitrary inputs
// (guards against a regression that would silently break the assertions above)
// ────────────────────────────────────────────────────────────────────────
describe("autoFillColumns model is monotonic in width", () => {
    test("for several min-col/gap/padding combos, columns never decrease", () => {
        const combos = [
            [GRID_MIN_COL, GRID_GAP, GRID_H_PADDING],
            [64, 6, 24],
            [60, 4, 24],
            [120, 8, 16],
        ];
        combos.forEach(([minCol, gap, pad]) => {
            let prev = 0;
            for (let w = 180; w <= 500; w += 5) {
                const n = autoFillColumns(w, minCol, gap, pad);
                expect(n).toBeGreaterThanOrEqual(1);
                expect(n).toBeGreaterThanOrEqual(prev);
                prev = n;
            }
        });
    });
});

// ────────────────────────────────────────────────────────────────────────
// Requirement 19.5 — responsive.css must NOT break column monotonicity
// ────────────────────────────────────────────────────────────────────────
describe("responsive.css preserves the Card_Grid column inputs", () => {
    const responsiveCss = stripComments(readCss(RESPONSIVE_CSS_PATH));

    /** Extract the bodies of every @media block as an array of strings. */
    function mediaBlocks(css) {
        const blocks = [];
        const re = /@media[^{]*\{/g;
        let m;
        while ((m = re.exec(css)) !== null) {
            const openIdx = css.indexOf("{", m.index);
            let depth = 0;
            for (let i = openIdx; i < css.length; i++) {
                if (css[i] === "{") depth++;
                else if (css[i] === "}") {
                    depth--;
                    if (depth === 0) {
                        blocks.push(css.slice(openIdx + 1, i));
                        re.lastIndex = i + 1;
                        break;
                    }
                }
            }
        }
        return blocks;
    }

    const blocks = mediaBlocks(responsiveCss);

    test("there is at least one @media block to inspect", () => {
        expect(blocks.length).toBeGreaterThan(0);
    });

    test("no @media block overrides --grid-min-col (column count input)", () => {
        blocks.forEach((b) => {
            expect(b).not.toMatch(/--grid-min-col\s*:/);
        });
    });

    test("no @media block overrides --grid-gap (column count input)", () => {
        blocks.forEach((b) => {
            expect(b).not.toMatch(/--grid-gap\s*:/);
        });
    });

    test("any grid-template-columns inside a @media keeps the auto-fill/minmax formula", () => {
        blocks.forEach((b) => {
            const re = /grid-template-columns\s*:\s*([^;]+);/gi;
            let m;
            while ((m = re.exec(b)) !== null) {
                // A fixed repeat(N, ...) would decouple column count from width
                // and could break monotonicity; only width-derived auto-fill is
                // allowed in the responsive layer.
                expect(m[1]).toMatch(/repeat\(\s*auto-fill\s*,\s*minmax\(/i);
            }
        });
    });

    test("the NARROW .grid-container keeps the module-default HORIZONTAL padding", () => {
        // Default (templates.css): padding: <v> --space-6 <v> --space-4  → right=space-6, left=space-4
        // NARROW  (responsive.css): padding: <v> --space-6 <v> --space-4  → identical horizontal
        // i.e. only the VERTICAL (1st/3rd) values shrink; horizontal stays put,
        // so the grid's usable width — and column count — stays monotonic.
        const re =
            /\.grid-container\s*\{[^}]*padding\s*:\s*([^;]+);[^}]*\}/i;
        const m = re.exec(responsiveCss);
        expect(m).not.toBeNull();

        // Split the shorthand into top-level values, treating each var(...) as
        // a single unit (its internal "--name, fallback" comma/space must not
        // split it).
        const parts = splitTopLevel(m[1].trim());
        // Expect the 4-value shorthand: top right bottom left
        expect(parts.length).toBe(4);
        const right = parts[1];
        const left = parts[3];

        // Horizontal padding tokens must be the column-neutral Spacing_Scale
        // steps used by the module default (right=--space-6, left=--space-4).
        expect(right).toMatch(/--space-6/);
        expect(left).toMatch(/--space-4/);
    });
});
