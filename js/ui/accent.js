// ============================================================
// ui/accent.js — Accent Theme System
// ------------------------------------------------------------
// Token-driven accent recolor. The accent family (--primary,
// --primary-hover/focus/bright, --p-700..--p-200, --p-bg/tint/
// rule/glow, --glow-violet-soft, --shadow-pop) is FROZEN in
// base.css :root and guarded by the token-stability test, so we
// never edit the source. Instead we OVERRIDE the family at runtime
// as inline custom properties on document.documentElement — the
// cascade lets these win over :root for the whole tree without a
// restart, and the "blue" default simply CLEARS the overrides so
// the frozen :root values apply byte-identically.
//
// Only the primary-accent family is recolored. Backgrounds,
// typography, surfaces, success (--gold), warning, error (--danger),
// and the amber secondary accent (--accent-purple, reserved for the
// text/creative module) are intentionally left untouched.
//
// Depends on globals (browser): document, Settings.
// Loaded after settings.js / settings-panel.js, before main.js.
// main.js calls Accent.init() during boot.
// ============================================================

var Accent = (function () {

    // ── Preset accent base colors (id -> base hex) ────────────────
    // "blue" reproduces the frozen --primary (#4f8cff). The others are
    // distinct hues; none reuse the banned legacy-violet hexes.
    var PRESETS = {
        blue: "#4f8cff",
        violet: "#9b7bff",
        teal: "#14b8a6",
        green: "#22c55e",
        amber: "#f59e0b",
        rose: "#f43f5e"
    };

    // Display order + labels for the Settings swatch row.
    var PRESET_ORDER = [
        { id: "blue", label: "Blue" },
        { id: "violet", label: "Violet" },
        { id: "teal", label: "Teal" },
        { id: "green", label: "Green" },
        { id: "amber", label: "Amber" },
        { id: "rose", label: "Rose" }
    ];

    // The exact set of accent tokens this system owns. Deliberately
    // excludes every non-accent token (canvas/surface/ink/danger/gold/
    // accent-purple) so the recolor stays scoped (Req: accent only).
    var FAMILY_KEYS = [
        "--primary",
        "--primary-rgb",
        "--primary-hover",
        "--primary-hover-rgb",
        "--primary-focus",
        "--primary-focus-rgb",
        "--primary-bright",
        "--primary-bright-rgb",
        "--p-700",
        "--p-600",
        "--p-500",
        "--p-400",
        "--p-300",
        "--p-200",
        "--p-bg",
        "--p-tint",
        "--p-rule",
        "--p-glow",
        "--glow-violet-soft",
        "--shadow-pop",
        "--accent-on-color"
    ];

    // Logo accent tokens — driven separately from the base accent family.
    // These recolor the flask icon + glow. Their DEFAULT values (brand purple)
    // live in header.css :root, not base.css (the brand purple #7c3aed is one of
    // the legacy-violet hexes purged from the base token system). On the default
    // "blue" preset these inline overrides are cleared so the purple branding in
    // header.css applies; any other accent overrides them to follow the accent.
    var LOGO_KEYS = ["--logo-flask", "--logo-glow", "--logo-glow-soft"];

    // Secondary accent tokens — a LIGHTER / SOFTER, lower-emphasis variation of
    // the primary accent (never identical), generated from the same selected
    // color so the secondary follows the accent while preserving hierarchy.
    // --t-400 is base.css `var(--accent-purple)` and follows automatically, so
    // only the base hue + its alpha tints are overridden. Cleared on Default,
    // returning to the frozen original (warm amber) branding.
    var SECONDARY_KEYS = ["--accent-purple", "--t-bg", "--t-glow"];

    // Every key the runtime sets/clears on <html> (accent family + logo + secondary).
    var ALL_KEYS = FAMILY_KEYS.concat(LOGO_KEYS).concat(SECONDARY_KEYS);

    // ── Color helpers (pure) ──────────────────────────────────────

    /** Normalize "#rgb"/"#rrggbb" (case-insensitive) -> "#rrggbb" lowercase, else null. */
    function normalizeHex(hex) {
        if (typeof hex !== "string") return null;
        var s = hex.trim().toLowerCase();
        var m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
        if (m3) return "#" + m3[1] + m3[1] + m3[2] + m3[2] + m3[3] + m3[3];
        var m6 = /^#([0-9a-f]{6})$/.exec(s);
        if (m6) return "#" + m6[1];
        return null;
    }

    function hexToRgb(hex) {
        var n = normalizeHex(hex) || "#000000";
        return {
            r: parseInt(n.slice(1, 3), 16),
            g: parseInt(n.slice(3, 5), 16),
            b: parseInt(n.slice(5, 7), 16)
        };
    }

    function _clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

    function _toHex2(v) {
        var h = _clamp(Math.round(v), 0, 255).toString(16);
        return h.length === 1 ? "0" + h : h;
    }

    function rgbToHex(r, g, b) {
        return "#" + _toHex2(r) + _toHex2(g) + _toHex2(b);
    }

    /** rgba(...) string matching the existing token formatting ("r, g, b, a"). */
    function rgba(hex, a) {
        var c = hexToRgb(hex);
        return "rgba(" + c.r + ", " + c.g + ", " + c.b + ", " + a + ")";
    }

    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        var max = Math.max(r, g, b), min = Math.min(r, g, b);
        var h, s, l = (max + min) / 2;
        if (max === min) {
            h = s = 0;
        } else {
            var d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                default: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }
        return { h: h, s: s, l: l };
    }

    function hslToRgb(h, s, l) {
        var r, g, b;
        if (s === 0) {
            r = g = b = l;
        } else {
            var hue2rgb = function (p, q, t) {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            var p = 2 * l - q;
            r = hue2rgb(p, q, h + 1 / 3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1 / 3);
        }
        return { r: r * 255, g: g * 255, b: b * 255 };
    }

    /** Shift lightness by delta (-1..1) in HSL space, return "#rrggbb". */
    function shiftL(hex, delta) {
        var c = hexToRgb(hex);
        var hsl = rgbToHsl(c.r, c.g, c.b);
        hsl.l = _clamp(hsl.l + delta, 0, 1);
        var out = hslToRgb(hsl.h, hsl.s, hsl.l);
        return rgbToHex(out.r, out.g, out.b);
    }

    /** Shift lightness AND saturation in HSL space, return "#rrggbb". */
    function adjustSL(hex, dL, dS) {
        var c = hexToRgb(hex);
        var hsl = rgbToHsl(c.r, c.g, c.b);
        hsl.l = _clamp(hsl.l + dL, 0, 1);
        hsl.s = _clamp(hsl.s + dS, 0, 1);
        var out = hslToRgb(hsl.h, hsl.s, hsl.l);
        return rgbToHex(out.r, out.g, out.b);
    }

    /** Calculate relative luminance of a hex color to determine text contrast. */
    function getLuminance(hex) {
        var rgb = hexToRgb(hex);
        var a = [rgb.r, rgb.g, rgb.b].map(function (v) {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
    }

    /**
     * Compute the full accent token family from a base hex. The alpha tints
     * (--p-bg/tint/rule/glow) and the two accent shadows reuse the EXACT alpha
     * values and formatting of the frozen base.css tokens so only the hue moves.
     */
    function computeFamily(baseHex) {
        var hex = normalizeHex(baseHex) || PRESETS.blue;
        var hover = shiftL(hex, 0.07);
        var focus = shiftL(hex, -0.09);
        var family = {};

        var cPrimary = hexToRgb(hex);
        var cHover = hexToRgb(hover);
        var cFocus = hexToRgb(focus);
        var brightHex = shiftL(hex, 0.12);
        var cBright = hexToRgb(brightHex);

        family["--primary"] = hex;
        family["--primary-rgb"] = cPrimary.r + ", " + cPrimary.g + ", " + cPrimary.b;
        family["--primary-hover"] = hover;
        family["--primary-hover-rgb"] = cHover.r + ", " + cHover.g + ", " + cHover.b;
        family["--primary-focus"] = focus;
        family["--primary-focus-rgb"] = cFocus.r + ", " + cFocus.g + ", " + cFocus.b;
        family["--primary-bright"] = brightHex;
        family["--primary-bright-rgb"] = cBright.r + ", " + cBright.g + ", " + cBright.b;
        family["--p-700"] = focus;
        family["--p-600"] = hex;
        family["--p-500"] = hex;
        family["--p-400"] = hover;
        family["--p-300"] = shiftL(hex, 0.18);
        family["--p-200"] = shiftL(hex, 0.34);
        family["--p-bg"] = rgba(hex, 0.11);
        family["--p-tint"] = rgba(hex, 0.19);
        family["--p-rule"] = rgba(hex, 0.40);
        family["--p-glow"] = rgba(hex, 0.60);
        family["--glow-violet-soft"] = "0 0 10px " + rgba(hex, 0.25);
        family["--shadow-pop"] =
            "0 12px 30px rgba(0, 0, 0, 0.55), 0 0 0 1px " + rgba(hex, 0.40) +
            ", 0 0 24px " + rgba(hex, 0.22);

        // Text/icon foreground for accent-filled controls
        var isLight = getLuminance(hex) > 0.45;
        family["--accent-on-color"] = isLight ? "#111111" : "#ffffff";

        return family;
    }

    /**
     * Compute the logo accent tokens from a base hex. The flask body takes the
     * base hue; the wave/glow/gas take a lightened tone (mirroring the brand's
     * deep #7c3aed liquid + light #b87af0 highlight two-tone identity).
     */
    function computeLogo(baseHex) {
        var hex = normalizeHex(baseHex) || PRESETS.blue;
        var glowHue = shiftL(hex, 0.18);
        return {
            "--logo-flask": hex,
            "--logo-glow": glowHue,
            // Soft, translucent halo color — subtle/premium glow (Req: reduced
            // opacity + brightness). Follows the accent via the same hue.
            "--logo-glow-soft": rgba(glowHue, 0.38)
        };
    }

    /**
     * Compute the secondary accent tokens from a base hex. The secondary is a
     * LIGHTER, slightly desaturated tint of the primary — a distinct, lower-
     * emphasis variation (never the exact primary color) that preserves the
     * visual hierarchy. On the dark theme a lighter tint also keeps/raises
     * contrast against the near-black canvas.
     */
    function computeSecondary(baseHex) {
        var hex = normalizeHex(baseHex) || PRESETS.blue;
        var sec = adjustSL(hex, 0.16, -0.10);
        return {
            "--accent-purple": sec,
            "--t-bg": rgba(sec, 0.11),
            "--t-glow": rgba(sec, 0.40)
        };
    }

    /** Resolve a (presetId, customHex) selection to the base accent hex. */
    function resolveHex(presetId, customHex) {
        if (presetId === "custom") return normalizeHex(customHex) || PRESETS.blue;
        return (typeof presetId === "string" &&
            Object.prototype.hasOwnProperty.call(PRESETS, presetId))
            ? PRESETS[presetId] : PRESETS.blue;
    }

    // ── Obsidian design tokens (tokens.css) ───────────────────────
    // accent.js writes only the tokens CSS cannot derive on Chromium 88
    // (no color-mix()): the user accent, its RGB channels and the two
    // HSL-shifted shades. --cs-accent, --cs-accent-subtle/glow and
    // --cs-border-focus are derived in tokens.css from these, and
    // --cs-accent-contrast stays static in tokens.css.
    var CS_INLINE_KEYS = [
        "--cs-user-accent",
        "--cs-accent-r",
        "--cs-accent-g",
        "--cs-accent-b",
        "--cs-accent-hover",
        "--cs-accent-active"
    ];

    // Tokens an earlier accent.js wrote inline. They now have a single
    // source in tokens.css, so any stale inline value is removed.
    var CS_RETIRED_KEYS = [
        "--cs-accent",
        "--cs-accent-subtle",
        "--cs-accent-glow",
        "--cs-border-focus"
    ];

    /**
     * True when the selection names one of the presets, or is "custom" with a
     * valid 3- or 6-digit hex color (either case). Anything else is unknown
     * and falls back to the blue preset (#4f8cff).
     */
    function isKnownSelection(presetId, customHex) {
        if (presetId === "custom") return normalizeHex(customHex) !== null;
        return typeof presetId === "string" &&
            Object.prototype.hasOwnProperty.call(PRESETS, presetId);
    }

    /**
     * Pure: the inline Obsidian tokens for a base hex. An invalid hex resolves
     * to the blue preset. --cs-user-accent is always lowercase #rrggbb.
     */
    function computeObsidian(baseHex) {
        var hex = normalizeHex(baseHex) || PRESETS.blue;
        var c = hexToRgb(hex);
        return {
            "--cs-user-accent": hex,
            "--cs-accent-r": String(c.r),
            "--cs-accent-g": String(c.g),
            "--cs-accent-b": String(c.b),
            "--cs-accent-hover": shiftL(hex, 0.07),
            "--cs-accent-active": shiftL(hex, -0.09)
        };
    }

    // ── Runtime application (browser only) ────────────────────────

    function _root() {
        return (typeof document !== "undefined" && document.documentElement) || null;
    }

    /**
     * Remove every inline legacy accent override so the frozen :root values
     * apply. Never touches CS_INLINE_KEYS: the Obsidian tokens are set for
     * every selection.
     */
    function _clearOverrides(root) {
        for (var i = 0; i < ALL_KEYS.length; i++) {
            root.style.removeProperty(ALL_KEYS[i]);
        }
    }

    /** Set every key/value of an object as an inline custom property on root. */
    function _setAll(root, obj) {
        for (var k in obj) {
            if (obj.hasOwnProperty(k)) root.style.setProperty(k, obj[k]);
        }
    }

    /**
     * Apply an accent selection at runtime. The Obsidian tokens
     * (CS_INLINE_KEYS) are written for EVERY selection, "blue" included, and
     * stale inline CS_RETIRED_KEYS are removed. For the legacy family, "blue"
     * (or an unknown selection) clears the overrides (frozen default for the
     * accent family, brand purple for the logo via header.css, warm amber for
     * the secondary via base.css); any other preset or a valid custom hex sets
     * the computed accent family, logo tokens AND the secondary accent as
     * inline custom properties on <html>. An unknown preset or an invalid
     * custom hex resolves to #4f8cff; apply never writes Settings and never
     * shows a toast. No restart, no layout reflow.
     */
    function apply(presetId, customHex) {
        var root = _root();
        if (!root) return;
        var known = isKnownSelection(presetId, customHex);
        var hex = known ? resolveHex(presetId, customHex) : PRESETS.blue;
        for (var i = 0; i < CS_RETIRED_KEYS.length; i++) {
            root.style.removeProperty(CS_RETIRED_KEYS[i]);
        }
        _setAll(root, computeObsidian(hex));
        if (presetId === "blue" || !known) {
            _clearOverrides(root);
            return;
        }
        _setAll(root, computeFamily(hex));
        _setAll(root, computeLogo(hex));
        _setAll(root, computeSecondary(hex));
    }

    /** The currently-resolved base hex (for UI display). */
    function getActiveHex() {
        if (typeof Settings === "undefined") return PRESETS.blue;
        return resolveHex(Settings.get("appearance.accent"), Settings.get("appearance.accentCustom"));
    }

    /**
     * Read the persisted accent from Settings, apply it, and subscribe so any
     * later change (preset click or custom-picker input) re-applies live.
     */
    function init() {
        if (typeof Settings === "undefined") return;
        apply(Settings.get("appearance.accent"), Settings.get("appearance.accentCustom"));
        if (init._subscribed) return;
        init._subscribed = true;
        var offPreset = Settings.onChange("appearance.accent", function (val) {
            apply(val, Settings.get("appearance.accentCustom"));
        });
        var offCustom = Settings.onChange("appearance.accentCustom", function (hex) {
            if (Settings.get("appearance.accent") === "custom") apply("custom", hex);
        });
        if (typeof FeatureFlags !== "undefined" && FeatureFlags.flags.lifecycleV1 &&
            typeof AppLifecycle !== "undefined") {
            AppLifecycle.subscribe(function () {
                offPreset(); offCustom(); init._subscribed = false;
            });
        }
    }

    return {
        PRESETS: PRESETS,
        PRESET_ORDER: PRESET_ORDER,
        FAMILY_KEYS: FAMILY_KEYS,
        LOGO_KEYS: LOGO_KEYS,
        SECONDARY_KEYS: SECONDARY_KEYS,
        CS_INLINE_KEYS: CS_INLINE_KEYS,
        CS_RETIRED_KEYS: CS_RETIRED_KEYS,
        normalizeHex: normalizeHex,
        shiftL: shiftL,
        isKnownSelection: isKnownSelection,
        computeObsidian: computeObsidian,
        computeFamily: computeFamily,
        computeLogo: computeLogo,
        computeSecondary: computeSecondary,
        resolveHex: resolveHex,
        apply: apply,
        getActiveHex: getActiveHex,
        init: init
    };

})();

// Node/CommonJS export for tests (pure logic is safe to require — apply()/init()
// touch document/Settings only when called, never at load time).
if (typeof module !== "undefined" && module.exports) {
    module.exports = Accent;
}
