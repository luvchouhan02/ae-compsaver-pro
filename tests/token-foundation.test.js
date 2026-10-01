/**
 * Token Foundation Static-Analysis Tests (Task 1.2)
 *
 * Static analysis of css/base.css `:root` design-token foundation. These tests
 * read base.css as text (Node env, no DOM) and assert structural guarantees
 * about the redesigned Design_System.
 *
 * **Validates: Requirements 3.2, 3.7, 3.8**
 *
 * - 3.2 (token-name preservation): the redesign token-name set MUST be a
 *   SUPERSET of the captured baseline set. Additions are allowed; removals or
 *   renames break references and MUST fail. The baseline below is the current
 *   `:root` token-name set captured at the time the redesign was applied.
 * - 3.7 (no purple/violet palette retained): known legacy violet hex values
 *   MUST NOT appear as token VALUES in `base.css :root`.
 * - 3.8 (token-first): the foundation is defined as tokens in `:root`, which
 *   this static analysis depends on and verifies the shape of.
 */

const fs = require('fs');
const path = require('path');

const BASE_CSS_PATH = path.join(__dirname, '..', 'css', 'base.css');

// ────────────────────────────────────────────────────────────────────────
// Baseline: the committed snapshot of `:root` token NAMES.
// Captured from css/base.css at the time the redesign was applied. Going
// forward, every name here MUST remain present in base.css (superset rule).
// To intentionally add tokens: leave this list alone (additions are allowed).
// To intentionally rename/remove a token: update JS references AND this list
// in the same change set (per Requirement 2.2).
// ────────────────────────────────────────────────────────────────────────
const BASELINE_TOKEN_NAMES = [
    '--canvas',
    '--surface-1',
    '--surface-2',
    '--surface-3',
    '--surface-4',
    '--hairline',
    '--hairline-strong',
    '--hairline-tertiary',
    '--primary',
    '--primary-hover',
    '--primary-focus',
    '--primary-bright',
    '--accent-purple',
    '--ink',
    '--ink-muted',
    '--ink-subtle',
    '--ink-tertiary',
    '--void',
    '--base',
    '--raised',
    '--surface',
    '--lift',
    '--ui',
    '--line-sub',
    '--line-dim',
    '--line-mid',
    '--line-hi',
    '--p-700',
    '--p-600',
    '--p-500',
    '--p-400',
    '--p-300',
    '--p-200',
    '--p-bg',
    '--p-tint',
    '--p-rule',
    '--p-glow',
    '--t-400',
    '--t-bg',
    '--tx-hi',
    '--tx-mid',
    '--tx-lo',
    '--tx-mute',
    '--danger',
    '--danger-bg',
    '--danger-rule',
    '--gold',
    '--gold-bg',
    '--gold-rule',
    '--font-sans',
    '--font-mono',
    '--r-xs',
    '--r-sm',
    '--r-md',
    '--r-lg',
    '--r-xl',
    '--r-pill',
    '--f-ui',
    '--f-sm',
    '--f-xs',
    '--f-xxs',
    '--f-micro',
    '--f-nano',
    '--tk-min-width',
    '--tm-min-width',
    '--tk-bg-deep',
    '--shadow-sm',
    '--shadow-md',
    '--shadow-lg',
    '--shadow-pop',
    '--glow-violet-soft',
    '--focus-ring',
    '--card-grad',
    '--glass-blur',
    '--hover-lift',
    '--ease-out',
    '--ease-spring',
    '--ease-in-out',
    '--dur-fast',
    '--dur-base',
    '--dur-slow',
];

// Known legacy violet hex values that the redesign replaced. None of these may
// survive as a token VALUE in the redesigned `:root`. (Requirement 3.7)
const LEGACY_VIOLET_HEXES = ['#8b5cf6', '#7c3aed', '#a78bfa', '#d96bf5', '#b794ff'];

// ────────────────────────────────────────────────────────────────────────
// Helpers — parse base.css as text and extract the first `:root { ... }` block.
// ────────────────────────────────────────────────────────────────────────

/** Read base.css from disk as a UTF-8 string. */
function readBaseCss() {
    return fs.readFileSync(BASE_CSS_PATH, 'utf8');
}

/**
 * Extract the contents (between the braces) of the first `:root { ... }` block.
 * Uses brace-depth counting so nested-looking content is handled robustly.
 */
function extractRootBlock(css) {
    const rootIdx = css.indexOf(':root');
    if (rootIdx === -1) return null;
    const openIdx = css.indexOf('{', rootIdx);
    if (openIdx === -1) return null;

    let depth = 0;
    for (let i = openIdx; i < css.length; i++) {
        const ch = css[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                return css.slice(openIdx + 1, i);
            }
        }
    }
    return null;
}

/** Strip CSS block comments (/* ... *\/) from a string. */
function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Parse `--name: value;` declarations from a (comment-stripped) :root block.
 * Returns an array of { name, value } objects.
 */
function parseDeclarations(rootBlock) {
    const clean = stripComments(rootBlock);
    const decls = [];
    const re = /(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = re.exec(clean)) !== null) {
        decls.push({ name: m[1], value: m[2].trim() });
    }
    return decls;
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe('Token Foundation: base.css :root parsing', () => {
    it('contains a parseable :root block with custom-property declarations', () => {
        const css = readBaseCss();
        const rootBlock = extractRootBlock(css);
        expect(rootBlock).not.toBeNull();

        const decls = parseDeclarations(rootBlock);
        expect(decls.length).toBeGreaterThan(0);
    });
});

describe('Token Foundation: token-name superset (Requirement 3.2)', () => {
    it('every baseline token name is still present in :root (no removals/renames)', () => {
        const css = readBaseCss();
        const rootBlock = extractRootBlock(css);
        expect(rootBlock).not.toBeNull();

        const currentNames = new Set(parseDeclarations(rootBlock).map((d) => d.name));

        // The current set MUST be a SUPERSET of the baseline set.
        const missing = BASELINE_TOKEN_NAMES.filter((name) => !currentNames.has(name));
        expect(missing).toEqual([]);
    });

    it('baseline snapshot has no duplicate entries (fixture integrity)', () => {
        const unique = new Set(BASELINE_TOKEN_NAMES);
        expect(unique.size).toBe(BASELINE_TOKEN_NAMES.length);
    });
});

describe('Token Foundation: no legacy violet palette in token values (Requirement 3.7)', () => {
    it('no legacy violet hex appears as a token VALUE in :root', () => {
        const css = readBaseCss();
        const rootBlock = extractRootBlock(css);
        expect(rootBlock).not.toBeNull();

        const decls = parseDeclarations(rootBlock);
        const offenders = [];

        for (const decl of decls) {
            const value = decl.value.toLowerCase();
            for (const hex of LEGACY_VIOLET_HEXES) {
                if (value.indexOf(hex) !== -1) {
                    offenders.push({ token: decl.name, value: decl.value, legacyHex: hex });
                }
            }
        }

        expect(offenders).toEqual([]);
    });

    it.each(LEGACY_VIOLET_HEXES)('legacy violet value %s is absent from all token values', (hex) => {
        const css = readBaseCss();
        const rootBlock = extractRootBlock(css);
        const decls = parseDeclarations(rootBlock);
        const found = decls.some((d) => d.value.toLowerCase().indexOf(hex) !== -1);
        expect(found).toBe(false);
    });
});
