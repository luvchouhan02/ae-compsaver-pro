/**
 * Accent Theme System — tests.
 *
 * Two layers, both deterministic under jest's "node" env (no DOM, no jsdom):
 *   1. Pure color logic of js/ui/accent.js (required directly; apply()/init()
 *      touch document/Settings only when called, never at load).
 *   2. Static analysis of the wiring (settings defaults/schema, settings-panel
 *      control, index.html script include, main.js init, base.css token reality).
 *
 * Guarantees asserted:
 *   - The accent system owns ONLY the primary-accent token family and never
 *     touches backgrounds/typography/surfaces/success/warning/error/secondary.
 *   - Every owned key is a real token defined in base.css :root.
 *   - The default ("blue") base equals the frozen --primary, and the alpha
 *     tints reuse the exact frozen alpha values.
 *   - The selection is persisted (settings) and restored at startup (main.js),
 *     and applied token-drivenly at runtime (inline custom props, no hardcode).
 */

const fs = require("fs");
const path = require("path");
const SA = require("./helpers/static-analysis");
const Accent = require("../js/ui/accent.js");

const baseCss = SA.read("css/base.css");
const settingsJs = SA.read("js/core/settings.js");
const settingsPanelJs = SA.read("js/ui/settings-panel.js");
const mainJs = SA.read("js/main.js");
const indexHtml = SA.composeMarkup();

// Non-accent tokens that MUST NOT be recolored by the accent system.
// (The secondary accent — --accent-purple / --t-400 / --t-bg / --t-glow — is
// now intentionally themed, so it is deliberately NOT in this list.)
const PROTECTED_TOKENS = [
    "--canvas", "--base", "--void",
    "--surface-1", "--surface-2", "--surface-3", "--surface-4",
    "--ink", "--ink-muted", "--ink-subtle", "--tx-hi", "--tx-mid",
    "--danger", "--danger-bg", "--danger-rule",
    "--gold", "--gold-bg", "--gold-rule",
    "--font-sans", "--font-mono"
];

/** Names of every custom property declared in the FIRST :root block of base.css. */
function rootTokenNames(css) {
    const i = css.indexOf(":root");
    const open = css.indexOf("{", i);
    let depth = 0, end = -1;
    for (let j = open; j < css.length; j++) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    const block = css.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
    const names = new Set();
    const re = /(--[a-z0-9-]+)\s*:/gi;
    let m;
    while ((m = re.exec(block)) !== null) names.add(m[1]);
    return names;
}

// ────────────────────────────────────────────────────────────────────────
// 1. Pure logic — presets & normalization
// ────────────────────────────────────────────────────────────────────────
describe("Accent presets & hex normalization", () => {
    test("the default 'blue' preset equals the frozen --primary (#4f8cff)", () => {
        expect(Accent.PRESETS.blue).toBe("#4f8cff");
    });

    test("PRESET_ORDER ids all exist in PRESETS and start with blue", () => {
        expect(Accent.PRESET_ORDER[0].id).toBe("blue");
        for (const p of Accent.PRESET_ORDER) {
            expect(typeof Accent.PRESETS[p.id]).toBe("string");
            expect(Accent.normalizeHex(Accent.PRESETS[p.id])).not.toBeNull();
        }
    });

    test("normalizeHex accepts #rgb and #rrggbb, rejects garbage", () => {
        expect(Accent.normalizeHex("#abc")).toBe("#aabbcc");
        expect(Accent.normalizeHex("#4F8CFF")).toBe("#4f8cff");
        expect(Accent.normalizeHex("4f8cff")).toBeNull();
        expect(Accent.normalizeHex("#12")).toBeNull();
        expect(Accent.normalizeHex("rgb(1,2,3)")).toBeNull();
        expect(Accent.normalizeHex(null)).toBeNull();
    });

    test("none of the presets reuse a banned legacy-violet hex", () => {
        const banned = ["#8b5cf6", "#7c3aed", "#a78bfa", "#d96bf5", "#b794ff"];
        for (const id in Accent.PRESETS) {
            expect(banned.indexOf(Accent.PRESETS[id])).toBe(-1);
        }
    });
});

// ────────────────────────────────────────────────────────────────────────
// 2. Pure logic — computeFamily
// ────────────────────────────────────────────────────────────────────────
describe("Accent.computeFamily", () => {
    const fam = Accent.computeFamily("#4f8cff");

    test("returns exactly the FAMILY_KEYS set", () => {
        expect(Object.keys(fam).sort()).toEqual(Accent.FAMILY_KEYS.slice().sort());
    });

    test("--primary / --p-600 / --p-500 equal the chosen base hex", () => {
        expect(fam["--primary"]).toBe("#4f8cff");
        expect(fam["--p-600"]).toBe("#4f8cff");
        expect(fam["--p-500"]).toBe("#4f8cff");
    });

    test("alpha tints reuse the exact frozen alpha values and rgb of the base", () => {
        expect(fam["--p-bg"]).toBe("rgba(79, 140, 255, 0.11)");
        expect(fam["--p-tint"]).toBe("rgba(79, 140, 255, 0.19)");
        expect(fam["--p-rule"]).toBe("rgba(79, 140, 255, 0.4)");
        expect(fam["--p-glow"]).toBe("rgba(79, 140, 255, 0.6)");
        expect(fam["--glow-violet-soft"]).toContain("rgba(79, 140, 255, 0.25)");
        expect(fam["--shadow-pop"]).toContain("rgba(79, 140, 255, 0.4)");
    });

    test("every produced value is a non-empty string", () => {
        for (const k of Accent.FAMILY_KEYS) {
            expect(typeof fam[k]).toBe("string");
            expect(fam[k].length).toBeGreaterThan(0);
        }
    });

    test("a custom hue moves --primary but keeps the tint structure", () => {
        const f2 = Accent.computeFamily("#22c55e");
        expect(f2["--primary"]).toBe("#22c55e");
        expect(f2["--p-bg"]).toBe("rgba(34, 197, 94, 0.11)");
        // derived shades are valid hex
        expect(Accent.normalizeHex(f2["--primary-hover"])).not.toBeNull();
        expect(Accent.normalizeHex(f2["--primary-focus"])).not.toBeNull();
        expect(Accent.normalizeHex(f2["--p-300"])).not.toBeNull();
    });

    test("resolveHex falls back to blue for unknown preset / bad custom", () => {
        expect(Accent.resolveHex("nope")).toBe("#4f8cff");
        expect(Accent.resolveHex("custom", "garbage")).toBe("#4f8cff");
        expect(Accent.resolveHex("custom", "#22c55e")).toBe("#22c55e");
        expect(Accent.resolveHex("teal")).toBe(Accent.PRESETS.teal);
    });
});

// ────────────────────────────────────────────────────────────────────────
// 3. Scope guarantee — only the accent family, nothing else
// ────────────────────────────────────────────────────────────────────────
describe("Accent scope isolation (Req: only accent UI changes)", () => {
    test("FAMILY_KEYS contains no protected (non-accent) token", () => {
        for (const t of PROTECTED_TOKENS) {
            expect(Accent.FAMILY_KEYS.indexOf(t)).toBe(-1);
        }
    });

    test("every accent FAMILY key is a real token defined in base.css :root", () => {
        const root = rootTokenNames(baseCss);
        for (const k of Accent.FAMILY_KEYS) {
            expect(root.has(k)).toBe(true);
        }
    });

    test("the protected (non-accent) tokens are NOT redefined inside the accent module source", () => {
        const accentSrc = SA.read("js/ui/accent.js");
        // Backgrounds, semantic success/warning/error colors are never themed.
        expect(accentSrc).not.toContain('"--danger"');
        expect(accentSrc).not.toContain('"--gold"');
        expect(accentSrc).not.toContain('"--canvas"');
        expect(accentSrc).not.toContain('"--surface-1"');
    });
});

// ────────────────────────────────────────────────────────────────────────
// 4. Persistence wiring (settings store)
// ────────────────────────────────────────────────────────────────────────
describe("Accent persistence in settings store", () => {
    test("defaults include appearance.accent = 'blue' and a custom hex", () => {
        expect(settingsJs).toMatch(/appearance\s*:\s*\{[\s\S]*?accent\s*:\s*["']blue["']/);
        expect(settingsJs).toMatch(/accentCustom\s*:\s*["']#4f8cff["']/i);
    });

    test("schema validates the accent enum (presets + custom) and the custom hex string", () => {
        expect(settingsJs).toMatch(/["']appearance\.accent["']\s*:\s*\{\s*type:\s*["']enum["']/);
        for (const id of ["blue", "violet", "teal", "green", "amber", "rose", "custom"]) {
            expect(settingsJs).toContain('"' + id + '"');
        }
        expect(settingsJs).toMatch(/["']appearance\.accentCustom["']\s*:\s*\{\s*type:\s*["']string["']/);
    });
});

// ────────────────────────────────────────────────────────────────────────
// 5. Startup restore + UI wiring + runtime token-driven application
// ────────────────────────────────────────────────────────────────────────
describe("Accent startup / UI / runtime wiring", () => {
    test("accent.js is loaded in index.html before main.js", () => {
        const accentIdx = indexHtml.indexOf("js/ui/accent.js");
        const mainIdx = indexHtml.indexOf("js/main.js");
        expect(accentIdx).toBeGreaterThan(-1);
        expect(mainIdx).toBeGreaterThan(-1);
        expect(accentIdx).toBeLessThan(mainIdx);
    });

    test("main.js restores the accent on startup via Accent.init()", () => {
        expect(mainJs).toMatch(/Accent\.init\(\)/);
    });

    test("the Settings panel renders an accent control bound to appearance.accent", () => {
        expect(settingsPanelJs).toMatch(/type:\s*["']accent["']/);
        expect(settingsPanelJs).toContain('key: "appearance.accent"');
        expect(settingsPanelJs).toContain("settings-accent-swatch");
        expect(settingsPanelJs).toContain("settings-accent-custom-btn");
    });

    test("the custom swatch opens the in-extension picker, not the native OS color dialog", () => {
        // No native <input type="color"> remains as the custom interaction.
        expect(settingsPanelJs).not.toMatch(/type=["']color["']/);
        expect(settingsPanelJs).toMatch(/AccentPicker\.open\(/);
    });

    test("the accent control persists selections through Settings.set (no bespoke storage)", () => {
        expect(settingsPanelJs).toMatch(/Settings\.set\(\s*["']appearance\.accent["']/);
        expect(settingsPanelJs).toMatch(/Settings\.set\(\s*["']appearance\.accentCustom["']/);
    });

    test("apply() is token-driven — it sets/removes CSS custom properties, no hardcoded element styling", () => {
        const src = SA.read("js/ui/accent.js");
        expect(src).toMatch(/style\.setProperty\(/);
        expect(src).toMatch(/style\.removeProperty\(/);
        // 'blue' default clears overrides so the frozen :root values apply.
        expect(src).toMatch(/presetId\s*===\s*["']blue["']/);
    });
});

// ────────────────────────────────────────────────────────────────────────
// 6. Logo integration with the Accent Theme System
// ────────────────────────────────────────────────────────────────────────
describe("Logo accent integration", () => {
    const headerCss = SA.read("css/header.css");

    test("LOGO_KEYS are --logo-flask / --logo-glow / --logo-glow-soft and are NOT part of the base accent family", () => {
        expect(Accent.LOGO_KEYS).toEqual(["--logo-flask", "--logo-glow", "--logo-glow-soft"]);
        for (const k of Accent.LOGO_KEYS) {
            expect(Accent.FAMILY_KEYS.indexOf(k)).toBe(-1);
        }
    });

    test("computeLogo returns exactly the LOGO_KEYS and follows the chosen hue", () => {
        const lg = Accent.computeLogo("#22c55e");
        expect(Object.keys(lg).sort()).toEqual(Accent.LOGO_KEYS.slice().sort());
        expect(lg["--logo-flask"]).toBe("#22c55e");
        expect(Accent.normalizeHex(lg["--logo-glow"])).not.toBeNull();
        // soft halo is a translucent rgba of the glow hue (reduced intensity)
        expect(lg["--logo-glow-soft"]).toMatch(/^rgba\(\d+, \d+, \d+, 0\.38\)$/);
    });

    test("the soft glow halo is reduced — translucent color + smaller spread", () => {
        // default soft token is translucent (alpha < 0.5), not a solid color
        expect(headerCss).toMatch(/--logo-glow-soft\s*:\s*rgba\([^)]*0\.38\)/);
        // the flask halo uses the soft token (not the solid --logo-glow) and a
        // reduced blur radius (<= 6px), keeping the drop-shadow blur style.
        const m = /\.flask-mini\s*\{([\s\S]*?)\}/.exec(headerCss);
        expect(m).not.toBeNull();
        expect(m[1]).toMatch(/filter:[\s\S]*var\(--logo-glow-soft\)/);
        expect(m[1]).toMatch(/drop-shadow\(0 0 6px/);
        expect(m[1]).not.toMatch(/drop-shadow\(0 0 10px/);
    });

    test("the brand purple defaults live in header.css :root, not base.css", () => {
        // header.css carries the default purple identity tokens.
        expect(headerCss).toMatch(/--logo-flask\s*:\s*#7c3aed/i);
        expect(headerCss).toMatch(/--logo-glow\s*:\s*#b87af0/i);
        // ...and the banned legacy-violet hex must NOT have leaked into base.css :root.
        const rootStart = baseCss.indexOf(":root");
        const rootBlock = baseCss.slice(rootStart, baseCss.indexOf("}", rootStart));
        expect(rootBlock.toLowerCase()).not.toContain("#7c3aed");
    });

    test("the flask consumes the logo tokens and hardcodes no accent color", () => {
        // header.css drives the flask fills + glow from the tokens.
        expect(headerCss).toMatch(/\.flask-liquid\s*\{[^}]*fill\s*:\s*var\(--logo-flask\)/);
        expect(headerCss).toMatch(/\.lwave\s*\{[^}]*fill\s*:\s*var\(--logo-glow\)/);
        expect(headerCss).toMatch(/\.fglow\s*\{[^}]*fill\s*:\s*var\(--logo-glow\)/);
        expect(headerCss).toMatch(/\.flask-mini\s*\{[\s\S]*?filter:[\s\S]*?var\(--logo-glow\)/);
        // the SVG markup no longer hardcodes the purple fills
        const flaskStart = indexHtml.indexOf('class="flask-mini"');
        const flaskEnd = indexHtml.indexOf("</svg>", flaskStart);
        const flask = indexHtml.slice(flaskStart, flaskEnd);
        expect(flask).not.toContain("#7c3aed");
        expect(flask).not.toContain("#b87af0");
        expect(flask).toContain('class="flask-liquid"');
    });

    test("the 'LAB.PRO' wordmark stays neutral (not accent-colored)", () => {
        const m = /\.brand-title\s*\{([^}]*)\}/.exec(headerCss);
        expect(m).not.toBeNull();
        expect(m[1]).toMatch(/color\s*:\s*var\(--tx-hi\)/);
        expect(m[1]).not.toMatch(/--p-|--primary|--logo-/);
    });

    test("apply() clears logo tokens too on the default preset (returns to purple)", () => {
        const src = SA.read("js/ui/accent.js");
        expect(src).toMatch(/ALL_KEYS\s*=\s*FAMILY_KEYS\.concat\(LOGO_KEYS\)/);
        expect(src).toMatch(/ALL_KEYS\.length/);
    });
});

// ────────────────────────────────────────────────────────────────────────
// 7. Secondary accent — follows the primary as a lighter, lower-emphasis tint
// ────────────────────────────────────────────────────────────────────────
describe("Secondary accent integration", () => {
    function channelSum(hex) {
        const n = Accent.normalizeHex(hex);
        return parseInt(n.slice(1, 3), 16) + parseInt(n.slice(3, 5), 16) + parseInt(n.slice(5, 7), 16);
    }

    test("SECONDARY_KEYS is the secondary family and is disjoint from primary + logo", () => {
        expect(Accent.SECONDARY_KEYS).toEqual(["--accent-purple", "--t-bg", "--t-glow"]);
        for (const k of Accent.SECONDARY_KEYS) {
            expect(Accent.FAMILY_KEYS.indexOf(k)).toBe(-1);
            expect(Accent.LOGO_KEYS.indexOf(k)).toBe(-1);
        }
    });

    test("computeSecondary returns exactly SECONDARY_KEYS", () => {
        const s = Accent.computeSecondary("#4f8cff");
        expect(Object.keys(s).sort()).toEqual(Accent.SECONDARY_KEYS.slice().sort());
    });

    test("the secondary is a DISTINCT, lighter variation of the primary (never identical)", () => {
        const primary = "#4f8cff";
        const sec = Accent.computeSecondary(primary)["--accent-purple"];
        expect(Accent.normalizeHex(sec)).not.toBeNull();
        expect(sec.toLowerCase()).not.toBe(primary.toLowerCase());
        expect(channelSum(sec)).toBeGreaterThan(channelSum(primary)); // lighter
    });

    test("secondary alpha tints derive from the secondary hue (0.11 / 0.40)", () => {
        const s = Accent.computeSecondary("#22c55e");
        expect(s["--t-bg"]).toMatch(/^rgba\(\d+, \d+, \d+, 0\.11\)$/);
        expect(s["--t-glow"]).toMatch(/^rgba\(\d+, \d+, \d+, 0\.4\)$/);
    });

    test("--t-glow is an additive secondary token defined in base.css :root (default amber)", () => {
        expect(baseCss).toMatch(/--t-glow\s*:\s*rgba\(255, 179, 71, 0\.40\)/);
    });

    test("apply() includes the secondary family in the runtime override set", () => {
        const src = SA.read("js/ui/accent.js");
        expect(src).toMatch(/ALL_KEYS\s*=\s*FAMILY_KEYS\.concat\(LOGO_KEYS\)\.concat\(SECONDARY_KEYS\)/);
        expect(src).toMatch(/computeSecondary\(hex\)/);
    });

    test("background / surface / text / success / warning / error stay out of every themed family", () => {
        const all = Accent.FAMILY_KEYS.concat(Accent.LOGO_KEYS).concat(Accent.SECONDARY_KEYS);
        for (const t of PROTECTED_TOKENS) {
            expect(all.indexOf(t)).toBe(-1);
        }
    });

    test("the body background amber ambient (a background, excluded) is left unchanged", () => {
        // Req: do not modify background colors — the faint ambient radial stays.
        expect(baseCss).toMatch(/radial-gradient\([^)]*rgba\(255, 179, 71, 0\.07\)/);
    });
});
