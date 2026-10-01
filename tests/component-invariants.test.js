/**
 * Component active-state and icon invariant tests.
 *
 * Spec: panel-layout-redesign — Task 2.3
 * **Validates: Requirements 6.2, 6.3, 6.4**
 *
 * The Component_System standardizes one structural pattern per component type
 * and one shared active-state treatment per type. Two structural guarantees are
 * checked here as deterministic static analysis over the committed source:
 *
 *   - 6.2 / 6.4 (single active instance): in the default-render markup of
 *     index.html, every switcher / tab / toggle group renders EXACTLY ONE
 *     element carrying the `.active` state class. More than one (or zero) active
 *     element in a group means the active-state contract is broken.
 *   - 6.3 (single-stroke icon system): the unified icon-system rule in
 *     base.css applies a single uniform stroke width (1.75) to every listed icon
 *     selector and sets `fill: none`, so icons render as single-stroke shapes
 *     with no filled (non-stroke) bodies.
 *
 * These read the source files as TEXT (Node env, no DOM), matching the existing
 * static-analysis test convention (see tests/helpers/static-analysis.js).
 */

const SA = require("./helpers/static-analysis");

const html = SA.composeMarkup();
const baseCss = SA.read("css/base.css");

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Extract the inner HTML of the first <div> whose class attribute contains the
 * given class token, balancing nested <div>/<\/div> pairs so the correct
 * closing tag is found regardless of nested structure.
 * Returns null if the container is not found.
 */
function extractContainerInner(source, containerClass) {
    const openRe = new RegExp(
        `<div\\b[^>]*class="[^"]*\\b${containerClass}\\b[^"]*"[^>]*>`,
        "i"
    );
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
            if (depth === 0) {
                return source.slice(bodyStart, m.index);
            }
        } else {
            depth++;
        }
    }
    return null;
}

/**
 * Count <button> elements within a chunk of HTML whose class attribute carries
 * the `active` token.
 */
function countActiveButtons(innerHtml) {
    const btnRe = /<button\b[^>]*>/gi;
    let m;
    let active = 0;
    let total = 0;
    while ((m = btnRe.exec(innerHtml)) !== null) {
        total++;
        const classMatch = /class="([^"]*)"/i.exec(m[0]);
        if (classMatch && /\bactive\b/.test(classMatch[1])) active++;
    }
    return { active, total };
}

/**
 * Parse flat CSS rules (selector + body) from a stylesheet. Adequate for the
 * top-level icon-system rule, which contains no nested braces.
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

// ────────────────────────────────────────────────────────────────────────
// Active-state invariants (Requirements 6.2, 6.4)
// ────────────────────────────────────────────────────────────────────────

// Named switcher / tab / toggle groups in the default-render markup. Each must
// render exactly one `.active` element.
const ACTIVE_GROUPS = [
    "main-switcher", // header main navigation (Toolkit / Templates / Settings)
    "tk-section-switcher", // Toolkit sub-section tabs (Tools / FX / Graph / Type)
    "flow-target-toggle", // ColorFlow Fill / Stroke (F / L) toggle
    "tk-flow-tabs-mini", // Flow Core / User / Recent tabs
    "section-switcher", // Templates 7-button section switcher
];

describe("Component active-state invariant — exactly one .active per group (Req 6.2, 6.4)", () => {
    test.each(ACTIVE_GROUPS)(
        "group .%s renders exactly one active element in default markup",
        (containerClass) => {
            const inner = extractContainerInner(html, containerClass);
            expect(inner).not.toBeNull();

            const { active, total } = countActiveButtons(inner);
            // The group must actually contain buttons (guards a broken extractor).
            expect(total).toBeGreaterThan(0);
            // Exactly one of them carries the active-state treatment.
            expect(active).toBe(1);
        }
    );
});

// ────────────────────────────────────────────────────────────────────────
// Icon-system invariants (Requirement 6.3)
// ────────────────────────────────────────────────────────────────────────

describe("Unified single-stroke icon system (Req 6.3)", () => {
    const rules = parseCssRules(baseCss);
    // The unified icon rule is the one whose body sets stroke-width: 1.75.
    const iconRule = rules.find((r) => /stroke-width:\s*1\.75/.test(r.body));

    test("a unified icon-system rule exists in base.css", () => {
        expect(iconRule).toBeDefined();
    });

    test("applies a uniform stroke width of 1.75 !important", () => {
        expect(iconRule.body).toMatch(/stroke-width:\s*1\.75\s*!important/);
    });

    test("declares exactly one stroke-width value (uniform across all icons)", () => {
        const widths = iconRule.body.match(/stroke-width:\s*[^;]+/gi) || [];
        expect(widths).toHaveLength(1);
    });

    test("sets fill: none so icons have no filled (non-stroke) shapes", () => {
        expect(iconRule.body).toMatch(/fill:\s*none/);
    });

    test("does not apply any fill other than none to the icon selectors", () => {
        const fills = iconRule.body.match(/(?:^|[^-])fill:\s*([^;]+)/gi) || [];
        for (const decl of fills) {
            expect(decl).toMatch(/fill:\s*none/i);
        }
    });

    test("covers the switcher/tab/toggle icon selectors", () => {
        // The icon contract must reach the icons inside the active-state groups.
        for (const sel of [
            ".main-nav-btn svg",
            ".section-btn svg",
            ".tk-section-btn svg",
            ".flow-target-btn svg",
        ]) {
            expect(iconRule.selector).toContain(sel);
        }
    });
});
