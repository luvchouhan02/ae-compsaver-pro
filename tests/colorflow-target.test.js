/**
 * ColorFlow target-toggle and swatch-rendering tests.
 *
 * Spec: panel-layout-redesign — Task 11.2
 * **Validates: Requirements 15.3, 15.5**
 *
 * Two structural guarantees of the restructured ColorFlow_Module are checked as
 * deterministic static analysis over the committed source (Node env, no DOM),
 * matching the existing static-analysis convention (tests/helpers/static-analysis.js):
 *
 *   - 15.3 (single active F/L target): in the default-render markup of
 *     index.html, the `#flow-target-toggle` group renders EXACTLY ONE
 *     `.flow-target-btn` carrying the `.active` state class, and the active
 *     treatment in css/colorflow.css differs from the inactive one in at least
 *     one visual property (background, foreground color, or border/box-shadow).
 *
 *   - 15.5 (stored swatch fills, never token colors): swatch fills are produced
 *     by js/toolkit/colorflow.js assigning `element.style.backgroundColor` from
 *     stored palette color values, and the `.flow-swatch` CSS rule in
 *     css/colorflow.css does NOT paint a background from a Design_Token `var()`.
 */

const SA = require("./helpers/static-analysis");

const html = SA.composeMarkup();
const colorflowCss = SA.read("css/colorflow.css");
const colorflowJs = SA.read("js/toolkit/colorflow.js");

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Extract the inner HTML of the first element whose id matches `id`, balancing
 * nested <div>/</div> pairs (the toggle is a <div id="flow-target-toggle">).
 * Returns null if not found.
 */
function extractByIdInner(source, id) {
    const openRe = new RegExp(`<div\\b[^>]*\\bid="${id}"[^>]*>`, "i");
    const openMatch = openRe.exec(source);
    if (!openMatch) return null;

    const bodyStart = openMatch.index + openMatch[0].length;
    const tagRe = /<div\b|<\/div>/gi;
    tagRe.lastIndex = bodyStart;

    let depth = 1;
    let m;
    while ((m = tagRe.exec(source)) !== null) {
        if (m[0].toLowerCase() === "</div>") {
            depth--;
            if (depth === 0) return source.slice(bodyStart, m.index);
        } else {
            depth++;
        }
    }
    return null;
}

/** Collect every <button ...> opening tag in a chunk of HTML. */
function buttonTags(innerHtml) {
    return innerHtml.match(/<button\b[^>]*>/gi) || [];
}

/** Does a button opening tag carry the `active` class token? */
function hasActiveClass(tag) {
    const classMatch = /class="([^"]*)"/i.exec(tag);
    return !!classMatch && /\bactive\b/.test(classMatch[1]);
}

/** Value of a given attribute in a single tag, or null. */
function attrValue(tag, attr) {
    const m = new RegExp(attr + '="([^"]*)"', "i").exec(tag);
    return m ? m[1] : null;
}

/**
 * Parse flat top-level CSS rules (selector + body). The .flow-swatch and
 * .flow-target-btn rules contain no nested braces, so this is adequate.
 */
function parseCssRules(css) {
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const re = /([^{}]+)\{([^{}]*)\}/g;
    const rules = [];
    let m;
    while ((m = re.exec(noComments)) !== null) {
        rules.push({ selector: m[1].trim(), body: m[2].trim() });
    }
    return rules;
}

const cssRules = parseCssRules(colorflowCss);

/** Find the first rule whose selector exactly equals `selector`. */
function ruleFor(selector) {
    return cssRules.find((r) => r.selector === selector);
}

// ────────────────────────────────────────────────────────────────────────
// 15.3 — exactly one active F/L target
// ────────────────────────────────────────────────────────────────────────

describe("ColorFlow F/L target toggle — exactly one active (Req 15.3)", () => {
    const inner = extractByIdInner(html, "flow-target-toggle");

    test("the #flow-target-toggle group is present in index.html", () => {
        expect(inner).not.toBeNull();
    });

    test("renders multiple .flow-target-btn options with exactly one .active", () => {
        const tags = buttonTags(inner).filter((t) =>
            /class="[^"]*\bflow-target-btn\b/.test(t)
        );
        // The Fill/Stroke (F/L) toggle must offer at least two targets.
        expect(tags.length).toBeGreaterThanOrEqual(2);

        const active = tags.filter(hasActiveClass);
        expect(active.length).toBe(1);
    });

    test("each target button carries a non-empty data-target value", () => {
        const tags = buttonTags(inner).filter((t) =>
            /class="[^"]*\bflow-target-btn\b/.test(t)
        );
        const targets = tags.map((t) => attrValue(t, "data-target"));
        for (const t of targets) {
            expect(typeof t).toBe("string");
            expect(t.trim()).not.toBe("");
        }
        // The two targets are distinct (one Fill, one Stroke/Label).
        expect(new Set(targets).size).toBe(targets.length);
    });

    test("the JS drives a single active target via renderTargetToggle", () => {
        // The active class is applied to exactly the button whose data-target
        // equals the single activeColorTarget, guaranteeing one active at a time.
        expect(colorflowJs).toMatch(/renderTargetToggle/);
        expect(colorflowJs).toMatch(
            /classList\.toggle\(\s*["']active["']\s*,\s*[^)]*dataset\.target\s*===\s*this\.activeColorTarget/
        );
    });

    test("the active treatment differs visually from the inactive one (Req 15.3)", () => {
        const activeRule = ruleFor(".flow-target-btn.active");
        expect(activeRule).toBeDefined();
        // Active state must differ in at least one of background / color / border.
        const differs =
            /background/.test(activeRule.body) ||
            /(^|[^-])color\s*:/.test(activeRule.body) ||
            /box-shadow|border/.test(activeRule.body);
        expect(differs).toBe(true);
    });
});

// ────────────────────────────────────────────────────────────────────────
// 15.5 — swatch fills come from stored values, not Design_Token vars
// ────────────────────────────────────────────────────────────────────────

describe("ColorFlow swatch fills come from stored values, not tokens (Req 15.5)", () => {
    test("the .flow-swatch CSS rule paints no background from a token var()", () => {
        const swatchRule = ruleFor(".flow-swatch");
        expect(swatchRule).toBeDefined();

        // Isolate any background / background-color declarations on the swatch.
        const bgDecls =
            swatchRule.body.match(/background(?:-color)?\s*:[^;]+/gi) || [];
        // The swatch rule must not set its fill from a Design_Token var().
        for (const decl of bgDecls) {
            expect(decl).not.toMatch(/var\(\s*--/);
        }
    });

    test("colorflow.js assigns swatch backgroundColor from stored palette colors", () => {
        // Active-strip swatches: fill is read from palette colors and set inline.
        expect(colorflowJs).toMatch(/currentPalette\.colors/);
        expect(colorflowJs).toMatch(
            /swatch\.style\.backgroundColor\s*=\s*col/
        );
        // The value assigned originates from a stored palette color, not a token.
        expect(colorflowJs).toMatch(
            /var\s+col\s*=\s*currentPalette\.colors\[\s*i\s*\]/
        );
    });

    test("no swatch fill is assigned from a CSS custom property in the JS", () => {
        // Guard: the inline backgroundColor assignment never uses a var(--token).
        const assignments =
            colorflowJs.match(/\.style\.backgroundColor\s*=\s*[^;]+/gi) || [];
        expect(assignments.length).toBeGreaterThan(0);
        for (const a of assignments) {
            expect(a).not.toMatch(/var\(\s*--/);
        }
    });
});
