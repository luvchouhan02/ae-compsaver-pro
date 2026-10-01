/**
 * Shared-systems layout redesign — static-analysis tests.
 *
 * Validates: Requirements 17.2, 20.5, 20.6
 *
 * Two invariants of the redesigned shared systems (Modal_System + the glass
 * surfaces across every redesign stylesheet) are asserted here by parsing the
 * CSS as text — no browser/runtime needed:
 *
 *   1. Danger-button distinction (Req 17.2): the destructive modal action
 *      button rule in `css/base.css`
 *      (`.modal-overlay .modal-buttons button.danger` / `.btn-danger` /
 *      `[data-variant='danger']` / `.cs-btn--danger`) is styled from the
 *      danger palette tokens (`--danger`, `--danger-bg`, `--danger-rule`) and
 *      is visually distinct from the shared non-destructive modal button rule
 *      (`.modal-overlay .modal-buttons button`), which uses none of those
 *      danger tokens.
 *
 *   2. backdrop-filter pairing + fallback (Req 20.5 / 20.6): across every
 *      redesign stylesheet, each rule that applies a `backdrop-filter` blur
 *      also declares a matching `-webkit-backdrop-filter` (Req 20.5) AND has
 *      an opaque/semi-opaque `background` / `background-color` fallback on the
 *      same element (Req 20.6) so the surface stays legible where the embedded
 *      Chromium runtime cannot paint the blur.
 *
 * Note (Req 20.6 "on the same element"): a fallback counts when it is declared
 * either in the same rule block OR on a sibling rule whose selector targets the
 * same element (e.g. a shared `.a, .b, .c { backdrop-filter }` rule paired with
 * per-element `.a { background } .b { background } .c { background }` rules).
 */

const fs = require("fs");
const path = require("path");

const CSS_DIR = path.resolve(__dirname, "..", "css");
const BASE_CSS = path.join(CSS_DIR, "base.css");

/** Absolute paths of every `.css` file under css/. */
function cssFiles() {
    return fs
        .readdirSync(CSS_DIR)
        .filter((name) => name.toLowerCase().endsWith(".css"))
        .map((name) => path.join(CSS_DIR, name));
}

/**
 * Read a file as UTF-8 text with CSS comments blanked out. Comment characters
 * are replaced by spaces (newlines preserved) so declaration/selector parsing
 * is not confused by inline comments while line numbers stay accurate.
 */
function read(file) {
    return fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** 1-based line number of a character offset within `content`. */
function lineAt(content, index) {
    let line = 1;
    for (let i = 0; i < index && i < content.length; i++) {
        if (content[i] === "\n") line++;
    }
    return line;
}

/** Collapse internal whitespace so value comparison ignores formatting. */
function normalize(value) {
    return value.replace(/\s+/g, " ").trim();
}

/**
 * Parse every *leaf* rule block (a `selector { ... }` whose body contains no
 * nested braces) out of a stylesheet. Returns objects describing the selector,
 * its comma-split individual selectors, the declarations, and the source
 * offset of the block body (for line reporting).
 */
function leafRules(content) {
    const rules = [];
    // [^{}]* can never span a brace, so group 1 is the immediate selector text
    // (everything since the previous brace) and group 2 is a brace-free body.
    const re = /([^{}]*)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(content)) !== null) {
        const selector = m[1].trim();
        if (!selector || selector.startsWith("@")) continue; // skip at-rule headers
        const body = m[2];
        const bodyStart = m.index + m[1].length + 1; // offset of body within file

        const declarations = [];
        let offset = 0;
        for (const decl of body.split(";")) {
            const declOffset = bodyStart + offset;
            offset += decl.length + 1; // +1 for the ';' removed by split
            const colon = decl.indexOf(":");
            if (colon === -1) continue;
            const prop = decl.slice(0, colon).trim().toLowerCase();
            const value = decl.slice(colon + 1).trim();
            if (prop) declarations.push({ prop, value, offset: declOffset });
        }

        rules.push({
            selector,
            parts: selector
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            declarations,
        });
    }
    return rules;
}

/** First declaration with the given property in a rule, or undefined. */
function declOf(rule, prop) {
    return rule.declarations.find((d) => d.prop === prop);
}

/** True if the rule declares a non-`none` background or background-color. */
function hasBackgroundFallback(rule) {
    return rule.declarations.some(
        (d) =>
            (d.prop === "background" || d.prop === "background-color") &&
            normalize(d.value).toLowerCase() !== "none"
    );
}

// ─────────────────────────────────────────────────────────────────────────
//  Req 17.2 — danger-button distinction in the Modal_System (base.css)
// ─────────────────────────────────────────────────────────────────────────
describe("Modal danger button distinction (Req 17.2)", () => {
    const rules = leafRules(read(BASE_CSS));

    // The destructive modal action button rule: scoped to .modal-buttons and
    // carrying at least one danger hook.
    const DANGER_HOOKS = [
        "button.danger",
        "button.btn-danger",
        "button[data-variant='danger']",
        ".cs-btn--danger",
    ];
    const dangerRule = rules.find(
        (r) =>
            r.selector.includes(".modal-buttons") &&
            !r.selector.includes(":hover") &&
            DANGER_HOOKS.some((hook) => r.selector.includes(hook))
    );

    // The shared non-destructive modal button rule.
    const baseButtonRule = rules.find(
        (r) =>
            r.parts.length === 1 &&
            r.parts[0] === ".modal-overlay .modal-buttons button"
    );

    test("a destructive modal button rule exists in base.css", () => {
        expect(dangerRule).toBeDefined();
    });

    test("the shared non-destructive modal button rule exists in base.css", () => {
        expect(baseButtonRule).toBeDefined();
    });

    test("the danger button rule covers every Class_Contract danger hook", () => {
        // Each hook must be present so any destructive button markup variant
        // (.danger / .btn-danger / [data-variant='danger'] / .cs-btn--danger)
        // receives the danger treatment.
        for (const hook of DANGER_HOOKS) {
            expect(dangerRule.selector).toContain(hook);
        }
    });

    test("the danger button rule is styled from the danger palette tokens", () => {
        const text = dangerRule.declarations
            .map((d) => `${d.prop}: ${d.value}`)
            .join("; ");
        // Distinct danger treatment is driven by the danger tokens.
        expect(text).toContain("--danger-bg");
        expect(text).toContain("--danger-rule");
        expect(text).toMatch(/var\(--danger\b/);

        // Concretely, background / border / color all carry danger styling.
        expect(normalize(declOf(dangerRule, "background").value)).toContain(
            "--danger-bg"
        );
        expect(normalize(declOf(dangerRule, "border").value)).toContain(
            "--danger-rule"
        );
        expect(normalize(declOf(dangerRule, "color").value)).toContain(
            "--danger"
        );
    });

    test("the danger treatment is visually distinct from the non-danger modal button", () => {
        // The shared non-destructive button rule must NOT reference any danger
        // token — otherwise the two would be indistinguishable.
        const baseText = baseButtonRule.declarations
            .map((d) => `${d.prop}: ${d.value}`)
            .join("; ");
        expect(baseText).not.toMatch(/--danger/);

        // And the danger rule must declare visual properties (color/background/
        // border) that the shared base button rule leaves unset, so the danger
        // button reads differently from a normal action button.
        const dangerProps = new Set(dangerRule.declarations.map((d) => d.prop));
        const baseProps = new Set(baseButtonRule.declarations.map((d) => d.prop));
        const distinguishing = ["background", "border", "color"].filter(
            (p) => dangerProps.has(p) && !baseProps.has(p)
        );
        expect(distinguishing.length).toBeGreaterThan(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────
//  Req 20.5 / 20.6 — backdrop-filter pairing + background fallback
// ─────────────────────────────────────────────────────────────────────────
describe("backdrop-filter pairing and background fallback (Req 20.5 / 20.6)", () => {
    const FILES = cssFiles();

    test("css/ directory contains stylesheets to analyze", () => {
        expect(FILES.length).toBeGreaterThan(0);
    });

    test("every blur backdrop-filter is paired with -webkit-backdrop-filter (Req 20.5)", () => {
        const problems = [];
        for (const file of FILES) {
            const rel = path.relative(CSS_DIR, file);
            const content = read(file);
            for (const rule of leafRules(content)) {
                for (const std of rule.declarations.filter(
                    (d) => d.prop === "backdrop-filter"
                )) {
                    if (normalize(std.value).toLowerCase() === "none") continue;
                    const paired = rule.declarations.some(
                        (d) =>
                            d.prop === "-webkit-backdrop-filter" &&
                            normalize(d.value) === normalize(std.value)
                    );
                    if (!paired) {
                        problems.push(
                            `  css/${rel}:${lineAt(content, std.offset)}  →  ` +
                            `backdrop-filter: ${std.value};  missing matching ` +
                            `-webkit-backdrop-filter: ${std.value};  ` +
                            `[selector: ${rule.selector}]`
                        );
                    }
                }
            }
        }
        if (problems.length > 0) {
            throw new Error(
                "Unpaired/mismatched backdrop-filter declaration(s):\n" +
                problems.join("\n")
            );
        }
        expect(problems).toEqual([]);
    });

    test("every blur backdrop-filter element has a background fallback (Req 20.6)", () => {
        const problems = [];
        for (const file of FILES) {
            const rel = path.relative(CSS_DIR, file);
            const content = read(file);
            const rules = leafRules(content);

            // Index: individual selector → does any rule declare a background
            // fallback for it? Resolves the "same element" case where a shared
            // backdrop rule pairs with per-element background rules.
            const bgBySelector = new Map();
            for (const rule of rules) {
                if (!hasBackgroundFallback(rule)) continue;
                for (const part of rule.parts) {
                    bgBySelector.set(part, true);
                }
            }

            for (const rule of rules) {
                for (const std of rule.declarations.filter(
                    (d) => d.prop === "backdrop-filter"
                )) {
                    if (normalize(std.value).toLowerCase() === "none") continue;

                    // Satisfied if the same block has the fallback, or every
                    // individual selector targeted by this backdrop rule has a
                    // background declared on the same element elsewhere.
                    const sameBlock = hasBackgroundFallback(rule);
                    const perElement =
                        rule.parts.length > 0 &&
                        rule.parts.every((p) => bgBySelector.get(p));
                    if (!sameBlock && !perElement) {
                        problems.push(
                            `  css/${rel}:${lineAt(content, std.offset)}  →  ` +
                            `backdrop-filter: ${std.value};  has no opaque/` +
                            `semi-opaque background fallback on the same element  ` +
                            `[selector: ${rule.selector}]`
                        );
                    }
                }
            }
        }
        if (problems.length > 0) {
            throw new Error(
                "backdrop-filter element(s) missing a background fallback " +
                "(Req 20.6):\n" + problems.join("\n")
            );
        }
        expect(problems).toEqual([]);
    });
});
