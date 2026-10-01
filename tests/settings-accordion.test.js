/**
 * Settings Accordion Interactivity Static-Analysis Tests
 *
 * Spec: panel-layout-redesign — Task 12.2
 * **Validates: Requirements 16.4, 16.5**
 *
 * The Settings_Panel renders each settings group as a self-contained accordion
 * card (.cs-accordion / .settings-section) whose body (.settings-section-body)
 * holds the interactive controls. The interactivity contract:
 *
 *   - 16.4 (collapsed = non-interactive): WHILE a section is collapsed, its
 *     controls accept NO keyboard focus and NO pointer interaction. The
 *     implementation enforces this with
 *         .settings-section:not(.expanded) > .settings-section-body { display:none }
 *     `display:none` removes the collapsed body from the layout, focus order,
 *     and pointer flow entirely — the strongest form of non-interactive.
 *
 *   - 16.5 (expanded = interactive): WHILE a section is expanded, its controls
 *     are interactive to keyboard and pointer. The implementation enforces this
 *     with
 *         .settings-section.expanded > .settings-section-body { display:block }
 *     a rendered, focusable, pointer-reachable body.
 *
 *   - Toggle behavior (16.2/16.3 mechanism that drives 16.4/16.5): activating a
 *     section header toggles the `.expanded` state class on its owning section,
 *     which is what flips the body between the two CSS rules above.
 *
 * These read css/settings.css and js/ui/settings-panel.js as TEXT (Node env, no
 * DOM), matching the static-analysis convention of the other suites in tests/.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SETTINGS_CSS_PATH = path.join(ROOT, "css", "settings.css");
const SETTINGS_PANEL_JS_PATH = path.join(ROOT, "js", "ui", "settings-panel.js");

// ────────────────────────────────────────────────────────────────────────
// Helpers — parse settings.css as text into flat (selector, body) rules.
// ────────────────────────────────────────────────────────────────────────

/** Strip CSS block comments so selectors inside comments are not matched. */
function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Parse flat CSS rules (selector + declaration body) from a stylesheet. The
 * accordion rules contain no nested braces, so a flat scan is sufficient and
 * deterministic. Selectors keep their `:not(...)` parentheses intact.
 */
function parseCssRules(css) {
    const clean = stripComments(css);
    const re = /([^{}]+)\{([^{}]*)\}/g;
    const rules = [];
    let m;
    while ((m = re.exec(clean)) !== null) {
        rules.push({ selector: m[1].trim(), body: m[2].trim() });
    }
    return rules;
}

/** Normalize whitespace around combinators so `a >b` and `a > b` compare equal. */
function normalizeSelector(sel) {
    return sel.replace(/\s*([>+~])\s*/g, "$1").replace(/\s+/g, " ").trim();
}

/** Parse `prop: value;` declarations from a rule body into a lowercased map. */
function parseDeclarations(body) {
    const map = {};
    // Bodies may omit a trailing semicolon on the final declaration.
    const re = /([a-z-]+)\s*:\s*([^;]+)/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
        map[m[1].toLowerCase().trim()] = m[2].trim().toLowerCase();
    }
    return map;
}

// Parse once, share across the suites.
const cssRules = parseCssRules(fs.readFileSync(SETTINGS_CSS_PATH, "utf8"));
const jsSource = fs.readFileSync(SETTINGS_PANEL_JS_PATH, "utf8");

describe("Settings accordion keyboard contract", () => {
    test("headers are native buttons linked to their controlled bodies", () => {
        expect(jsSource).toContain('<button type="button" class="cs-accordion__header settings-section-header" aria-expanded="false" aria-controls="settings-body-');
        expect(jsSource).toContain('class="cs-accordion__body settings-section-body" id="settings-body-');
    });

    test("click activation synchronizes the accessible expanded state", () => {
        expect(jsSource).toContain('this.setAttribute("aria-expanded", String(section.classList.contains("expanded")))');
    });
});

/** Find the first rule whose normalized selector list contains `target`. */
function findRuleBySelector(target) {
    const normTarget = normalizeSelector(target);
    return cssRules.find((r) =>
        normalizeSelector(r.selector)
            .split(",")
            .map((s) => s.trim())
            .includes(normTarget)
    );
}

// ────────────────────────────────────────────────────────────────────────
// Requirement 16.4 — collapsed section bodies are NON-interactive
// ────────────────────────────────────────────────────────────────────────
describe("Collapsed accordion sections expose non-interactive controls (Req 16.4)", () => {
    const collapsedRule = findRuleBySelector(
        ".settings-section:not(.expanded)>.settings-section-body"
    );

    test("a rule targets the body of a NOT-expanded (collapsed) section", () => {
        expect(collapsedRule).toBeDefined();
    });

    test("collapsed section body is removed from the focus/pointer flow (display:none)", () => {
        const decls = parseDeclarations(collapsedRule.body);
        // display:none takes the controls out of layout, tab order, and pointer
        // hit-testing entirely — they accept no keyboard focus and no pointer
        // interaction while collapsed.
        expect(decls["display"]).toBe("none");
    });

    test("sections render collapsed by default (no .expanded in the rendered template)", () => {
        // _renderSection seeds the section markup with `var expanded = ''` so the
        // initial class list omits `expanded` → the collapsed rule applies until
        // the user activates the header.
        expect(jsSource).toMatch(/var\s+expanded\s*=\s*['"]['"]\s*;/);
        // The body element actually carries the class the CSS rule targets.
        expect(jsSource).toMatch(/settings-section-body/);
    });
});

// ────────────────────────────────────────────────────────────────────────
// Requirement 16.5 — expanded section bodies are INTERACTIVE
// ────────────────────────────────────────────────────────────────────────
describe("Expanded accordion sections expose interactive controls (Req 16.5)", () => {
    const expandedRule = findRuleBySelector(
        ".settings-section.expanded>.settings-section-body"
    );

    test("a rule targets the body of an expanded section", () => {
        expect(expandedRule).toBeDefined();
    });

    test("expanded section body is rendered/visible so its controls are interactive", () => {
        const decls = parseDeclarations(expandedRule.body);
        // A non-`none` display value puts the body back into layout, tab order,
        // and pointer flow → controls are focusable and clickable when expanded.
        expect(decls["display"]).toBeDefined();
        expect(decls["display"]).not.toBe("none");
        // The implementation uses block; accept any visible display just in case.
        expect(["block", "flex", "grid", "inline", "inline-block"]).toContain(
            decls["display"]
        );
    });

    test("collapsed and expanded bodies use opposing display values (the contract)", () => {
        const collapsedRule = findRuleBySelector(
            ".settings-section:not(.expanded)>.settings-section-body"
        );
        const collapsed = parseDeclarations(collapsedRule.body)["display"];
        const expanded = parseDeclarations(expandedRule.body)["display"];
        expect(collapsed).toBe("none");
        expect(expanded).not.toBe(collapsed);
    });
});

// ────────────────────────────────────────────────────────────────────────
// Mechanism — header activation toggles the .expanded state (drives 16.4/16.5)
// ────────────────────────────────────────────────────────────────────────
describe("Section header activation toggles the expanded state", () => {
    test("a click handler is bound to the section headers", () => {
        // Headers are collected by their class and given a click listener.
        expect(jsSource).toMatch(
            /querySelectorAll\(\s*["'`]\.settings-section-header["'`]\s*\)/
        );
        expect(jsSource).toMatch(
            /\.settings-section-header[\s\S]{0,200}addEventListener\(\s*["'`]click["'`]/
        );
    });

    test("activating a header toggles the `expanded` class on its owning section", () => {
        // The handler resolves the owning section (the header's parent) and
        // flips the `expanded` state class — the single switch the CSS rules key
        // off of. This is what makes a collapsed header expand and an expanded
        // header collapse.
        expect(jsSource).toMatch(/classList\.toggle\(\s*["'`]expanded["'`]\s*\)/);
        expect(jsSource).toMatch(/parentElement/);
    });
});
