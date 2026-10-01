/**
 * Token Stability & Layout-Token Static-Analysis Tests (Task 1.2)
 *
 * Static analysis of css/base.css `:root` after the panel-layout-redesign
 * extended the Design_System with layout primitives. These tests read base.css
 * as text (Node env, no DOM) and assert:
 *
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5**
 *
 * - Compatibility token names remain a superset of the original set.
 *   Visual values follow the MNTools redesign; exact aliases below protect
 *   the neutral palette while retaining existing consumers.
 * - 4.3 (layout tokens resolve): the Spacing_Scale (`--space-0..7`), Density
 *   tokens, grid tokens, and structure tokens MUST exist and resolve to a
 *   non-empty value.
 * - 4.4 (Spacing_Scale distinctness): the `--space-0..7` step values MUST each
 *   be distinct from every other step.
 *
 * There is no separate committed pre-redesign snapshot file, so the baseline
 * below is the original palette/motion token NAME→VALUE set captured from the
 * pre-layout-primitives `:root`. The layout primitives are asserted to exist,
 * resolve, and (for the Spacing_Scale) be pairwise distinct.
 */

const fs = require('fs');
const path = require('path');

const BASE_CSS_PATH = path.join(__dirname, '..', 'css', 'base.css');

// ────────────────────────────────────────────────────────────────────────
// Baseline: pre-redesign `:root` token NAME → VALUE snapshot.
// Captured from css/base.css before the layout primitives were appended.
// Every name remains present. Visual expectations are migrated explicitly
// to the MNTools compatibility aliases; nonvisual values remain unchanged.
// Values are compared after whitespace normalization so insignificant spacing
// differences inside e.g. rgba(...) do not produce false failures.
// ────────────────────────────────────────────────────────────────────────
const BASELINE_ORIGINAL_TOKENS = {
    '--canvas': 'var(--cs-canvas)',
    '--surface-1': 'var(--cs-surface-1)',
    '--surface-2': 'var(--cs-surface-2)',
    '--surface-3': 'var(--cs-surface-3)',
    '--surface-4': 'var(--cs-surface-4)',
    '--hairline': 'var(--cs-border-subtle)',
    '--hairline-strong': 'var(--cs-border-medium)',
    '--hairline-tertiary': 'var(--cs-border-strong)',
    '--primary': '#4f8cff',
    '--primary-hover': '#6ba3ff',
    '--primary-focus': '#3b70e0',
    '--primary-bright': '#7db4ff',
    '--accent-purple': '#ffb347',
    '--ink': 'var(--cs-text-primary)',
    '--ink-muted': 'var(--cs-text-secondary)',
    '--ink-subtle': 'var(--cs-text-muted)',
    '--ink-tertiary': 'var(--cs-text-disabled)',
    '--void': 'var(--canvas)',
    '--base': 'var(--canvas)',
    '--raised': 'var(--surface-1)',
    '--surface': 'var(--surface-2)',
    '--lift': 'var(--surface-3)',
    '--ui': 'var(--surface-4)',
    '--line-sub': 'var(--hairline)',
    '--line-dim': 'var(--hairline-strong)',
    '--line-mid': 'var(--hairline-tertiary)',
    '--line-hi': 'rgba(140, 178, 255, 0.28)',
    '--p-700': 'var(--primary-focus)',
    '--p-600': 'var(--primary)',
    '--p-500': 'var(--primary)',
    '--p-400': 'var(--primary-hover)',
    '--p-300': '#9cc2ff',
    '--p-200': '#d2e3ff',
    '--p-bg': 'rgba(79, 140, 255, 0.11)',
    '--p-tint': 'rgba(79, 140, 255, 0.19)',
    '--p-rule': 'rgba(79, 140, 255, 0.40)',
    '--p-glow': 'rgba(79, 140, 255, 0.60)',
    '--t-400': 'var(--accent-purple)',
    '--t-bg': 'rgba(255, 179, 71, 0.11)',
    '--tx-hi': 'var(--ink)',
    '--tx-mid': 'var(--ink-muted)',
    '--tx-lo': 'var(--ink-subtle)',
    '--tx-mute': 'var(--ink-tertiary)',
    '--danger': '#ff2a5f',
    '--danger-bg': 'rgba(255, 42, 95, 0.12)',
    '--danger-rule': 'rgba(255, 42, 95, 0.3)',
    '--gold': '#ffc24b',
    '--gold-bg': 'rgba(255, 194, 75, 0.12)',
    '--gold-rule': 'rgba(255, 194, 75, 0.3)',
    '--font-sans': 'var(--cs-font-sans)',
    '--font-mono': 'var(--cs-font-mono)',
    '--r-xs': '4px',
    '--r-sm': '6px',
    '--r-md': '8px',
    '--r-lg': '8px',
    '--r-xl': '8px',
    '--r-pill': '9999px',
    '--f-ui': '13px',
    '--f-sm': '12px',
    '--f-xs': '11px',
    '--f-xxs': '10px',
    '--f-micro': '9px',
    '--f-nano': '8px',
    '--tk-min-width': '170px',
    '--tm-min-width': '180px',
    '--tk-bg-deep': 'var(--base)',
    '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.45), 0 1px 1px rgba(20, 40, 90, 0.18)',
    '--shadow-md': '0 4px 16px rgba(0, 0, 0, 0.50), 0 2px 6px rgba(15, 35, 80, 0.22)',
    '--shadow-lg': '0 14px 38px rgba(0, 0, 0, 0.60), 0 6px 16px rgba(15, 35, 80, 0.28)',
    '--shadow-pop': '0 12px 30px rgba(0, 0, 0, 0.55), 0 0 0 1px var(--p-rule), 0 0 24px rgba(79, 140, 255, 0.22)',
    '--glow-violet-soft': '0 0 10px rgba(79, 140, 255, 0.25)',
    '--focus-ring': '0 0 0 2px var(--primary)',
    '--card-grad': 'linear-gradient(180deg, var(--cs-surface-2), var(--cs-surface-1))',
    '--glass-blur': 'none',
    '--hover-lift': '0px',
    '--ease-out': 'cubic-bezier(0.22, 1, 0.36, 1)',
    '--ease-spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    '--ease-in-out': 'cubic-bezier(0.4, 0, 0.2, 1)',
    '--dur-fast': '0.12s',
    '--dur-base': '0.18s',
    '--dur-slow': '0.32s',
};

// Spacing_Scale step tokens — fixed, ordered (Req 4.4).
const SPACING_SCALE_TOKENS = [
    '--space-0',
    '--space-1',
    '--space-2',
    '--space-3',
    '--space-4',
    '--space-5',
    '--space-6',
    '--space-7',
];

// Density tokens (Req 4.3, 4.7).
const DENSITY_TOKENS = ['--density-pad', '--density-gap'];

// Grid tokens — Card_Grid sizing (Req 4.3).
const GRID_TOKENS = ['--grid-gap', '--grid-min-col', '--grid-col-max'];

// Structure tokens — shared structural conventions (Req 4.3).
const STRUCTURE_TOKENS = ['--toolbar-h', '--control-h', '--section-gap', '--section-pad'];

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

/** Strip CSS block comments from a string. */
function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Parse `--name: value;` declarations from a (comment-stripped) :root block.
 * Returns an object mapping name -> trimmed value (last declaration wins).
 */
function parseDeclarations(rootBlock) {
    const clean = stripComments(rootBlock);
    const map = {};
    const re = /(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = re.exec(clean)) !== null) {
        map[m[1]] = m[2].trim();
    }
    return map;
}

/** Collapse internal whitespace so insignificant spacing diffs don't fail. */
function normalize(value) {
    return value.replace(/\s+/g, ' ').trim();
}

/** Parse the :root token map once, asserting the block exists. */
function getRootTokens() {
    const css = readBaseCss();
    const rootBlock = extractRootBlock(css);
    expect(rootBlock).not.toBeNull();
    return parseDeclarations(rootBlock);
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe('Token Stability: base.css :root parsing', () => {
    it('contains a parseable :root block with custom-property declarations', () => {
        const tokens = getRootTokens();
        expect(Object.keys(tokens).length).toBeGreaterThan(0);
    });

    it('baseline snapshot keys are unique (fixture integrity)', () => {
        const keys = Object.keys(BASELINE_ORIGINAL_TOKENS);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe('Token Stability: original token set is preserved (Requirements 4.1, 4.2, 4.5)', () => {
    it('post-redesign token names are a SUPERSET of the baseline (no removals/renames)', () => {
        const tokens = getRootTokens();
        const currentNames = new Set(Object.keys(tokens));
        const missing = Object.keys(BASELINE_ORIGINAL_TOKENS).filter((name) => !currentNames.has(name));
        expect(missing).toEqual([]);
    });

    it('every compatibility token maps to its approved redesign value', () => {
        const tokens = getRootTokens();
        const mismatches = [];
        for (const [name, expected] of Object.entries(BASELINE_ORIGINAL_TOKENS)) {
            const actual = tokens[name];
            if (actual === undefined || normalize(actual) !== normalize(expected)) {
                mismatches.push({ token: name, expected, actual: actual ?? '(absent)' });
            }
        }
        expect(mismatches).toEqual([]);
    });

    it.each(Object.entries(BASELINE_ORIGINAL_TOKENS))(
        'original token %s resolves to its baseline value',
        (name, expected) => {
            const tokens = getRootTokens();
            expect(tokens[name]).toBeDefined();
            expect(normalize(tokens[name])).toBe(normalize(expected));
        }
    );
});

describe('Token Stability: layout tokens exist and resolve (Requirement 4.3)', () => {
    const ALL_LAYOUT_TOKENS = [
        ...SPACING_SCALE_TOKENS,
        ...DENSITY_TOKENS,
        ...GRID_TOKENS,
        ...STRUCTURE_TOKENS,
    ];

    it('every Spacing_Scale, density, grid, and structure token is declared in :root', () => {
        const tokens = getRootTokens();
        const missing = ALL_LAYOUT_TOKENS.filter((name) => !(name in tokens));
        expect(missing).toEqual([]);
    });

    it.each(ALL_LAYOUT_TOKENS)('layout token %s resolves to a non-empty value', (name) => {
        const tokens = getRootTokens();
        expect(tokens[name]).toBeDefined();
        expect(normalize(tokens[name]).length).toBeGreaterThan(0);
    });
});

describe('Spacing_Scale: ordered steps are pairwise distinct (Requirement 4.4)', () => {
    it('declares all of --space-0 .. --space-7', () => {
        const tokens = getRootTokens();
        const missing = SPACING_SCALE_TOKENS.filter((name) => !(name in tokens));
        expect(missing).toEqual([]);
    });

    it('every --space-* step value is distinct from every other step', () => {
        const tokens = getRootTokens();
        const values = SPACING_SCALE_TOKENS.map((name) => normalize(tokens[name]));
        const unique = new Set(values);
        expect(unique.size).toBe(SPACING_SCALE_TOKENS.length);
    });
});
