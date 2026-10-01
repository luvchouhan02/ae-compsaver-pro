/**
 * Custom Accent Color Picker — tests.
 *
 * Pure color-math (required directly; the popover DOM logic touches document
 * only when open() is called, never at load) + static analysis of the UI
 * contract: native color input removed, in-extension popover with the required
 * parts, FocusTrap + Escape + outside-click, transform/opacity animation, and
 * no external libraries. Node env, no jsdom.
 */

const SA = require("./helpers/static-analysis");
const Picker = require("../js/ui/accent-picker.js");

const pickerSrc = SA.read("js/ui/accent-picker.js");
const settingsPanelJs = SA.read("js/ui/settings-panel.js");
const settingsCss = SA.read("css/settings.css");
const indexHtml = SA.composeMarkup();

// ────────────────────────────────────────────────────────────────────────
// 1. Pure color math
// ────────────────────────────────────────────────────────────────────────
describe("AccentPicker color math", () => {
    test("normalizeHex accepts #rgb, #rrggbb, and bare hex; rejects garbage", () => {
        expect(Picker.normalizeHex("#abc")).toBe("#aabbcc");
        expect(Picker.normalizeHex("4f8cff")).toBe("#4f8cff");
        expect(Picker.normalizeHex("#4F8CFF")).toBe("#4f8cff");
        expect(Picker.normalizeHex("zzz")).toBeNull();
        expect(Picker.normalizeHex("#12")).toBeNull();
    });

    test("hex -> HSV -> hex round-trips for representative colors", () => {
        ["#4f8cff", "#22c55e", "#f43f5e", "#9b7bff", "#ffffff", "#000000", "#14b8a6"].forEach((hex) => {
            const rgb = Picker.hexToRgb(hex);
            const hsv = Picker.rgbToHsv(rgb.r, rgb.g, rgb.b);
            expect(Picker.hsvToHex(hsv.h, hsv.s, hsv.v)).toBe(hex);
        });
    });

    test("hsvToHex of pure hue endpoints is correct", () => {
        expect(Picker.hsvToHex(0, 1, 1)).toBe("#ff0000");
        expect(Picker.hsvToHex(120, 1, 1)).toBe("#00ff00");
        expect(Picker.hsvToHex(240, 1, 1)).toBe("#0000ff");
        expect(Picker.hsvToHex(0, 0, 1)).toBe("#ffffff"); // no saturation = white
        expect(Picker.hsvToHex(0, 0, 0)).toBe("#000000"); // no value = black
    });

    test("requiring the module does not touch the DOM (no Settings/document needed)", () => {
        expect(typeof Picker.open).toBe("function");
        expect(typeof Picker.close).toBe("function");
    });
});

// ────────────────────────────────────────────────────────────────────────
// 2. UI contract — native dialog replaced by the in-extension popover
// ────────────────────────────────────────────────────────────────────────
describe("Custom picker UI contract", () => {
    test("no native <input type=color> is used anywhere (settings panel or picker)", () => {
        expect(settingsPanelJs).not.toMatch(/type=["']color["']/);
        expect(pickerSrc).not.toMatch(/type["']?\s*[:=]\s*["']color["']/);
    });

    test("the picker builds the required parts (SV square, hue, hex, preview, reset/apply/cancel)", () => {
        expect(pickerSrc).toContain("accent-pop-sv");
        expect(pickerSrc).toContain("accent-pop-hue");
        expect(pickerSrc).toContain("accent-pop-hex-input");
        expect(pickerSrc).toContain("accent-pop-preview");
        expect(pickerSrc).toMatch(/btnReset/);
        expect(pickerSrc).toMatch(/btnApply/);
        expect(pickerSrc).toMatch(/btnCancel/);
    });

    test("closes on Escape and outside-click, and traps focus via FocusTrap", () => {
        expect(pickerSrc).toMatch(/Escape/);
        expect(pickerSrc).toMatch(/mousedown/); // outside-click dismissal
        expect(pickerSrc).toMatch(/FocusTrap\.activate/);
        expect(pickerSrc).toMatch(/FocusTrap\.deactivate/);
    });

    test("does open/close animation via a CSS class (transform + opacity only)", () => {
        expect(pickerSrc).toMatch(/classList\.add\(["']open["']\)/);
        expect(pickerSrc).toMatch(/classList\.remove\(["']open["']\)/);
        const m = /\.accent-pop\s*\{([\s\S]*?)\}/.exec(settingsCss);
        expect(m).not.toBeNull();
        expect(m[1]).toMatch(/transition:[\s\S]*opacity/);
        expect(m[1]).toMatch(/transform:/);
        // animated properties are only opacity/transform
        expect(m[1]).not.toMatch(/transition:[^;]*(width|height|left|top|margin|padding)/);
    });

    test("viewport collision handling computes position from getBoundingClientRect + innerWidth/Height", () => {
        expect(pickerSrc).toMatch(/getBoundingClientRect/);
        expect(pickerSrc).toMatch(/innerWidth/);
        expect(pickerSrc).toMatch(/innerHeight/);
    });

    test("uses no external libraries (no import / require of third-party modules)", () => {
        expect(pickerSrc).not.toMatch(/\brequire\(\s*["'][^.]/); // only relative/none
        expect(pickerSrc).not.toMatch(/^\s*import\s/m);
    });

    test("the popover is token-driven and CEP-safe (backdrop-filter paired, no forbidden features)", () => {
        const m = /\.accent-pop\s*\{([\s\S]*?)\}/.exec(settingsCss);
        expect(m[1]).toMatch(/backdrop-filter:/);
        expect(m[1]).toMatch(/-webkit-backdrop-filter:/);
        expect(m[1]).toMatch(/var\(--/); // built from tokens
        expect(settingsCss).not.toMatch(/:has\(|@container|@layer|color-mix\(/);
    });

    test("accent-picker.js is loaded before settings-panel.js in index.html", () => {
        const pIdx = indexHtml.indexOf("js/ui/accent-picker.js");
        const sIdx = indexHtml.indexOf("js/ui/settings-panel.js");
        expect(pIdx).toBeGreaterThan(-1);
        expect(sIdx).toBeGreaterThan(pIdx);
    });

    test("Apply routes through the unchanged Accent Theme Settings path (no new accent logic)", () => {
        // settings-panel's onApply commits via Settings.set — the same path the
        // old native input used. No Accent.* internals are modified here.
        expect(settingsPanelJs).toMatch(/onApply:\s*function[\s\S]*Settings\.set\(\s*["']appearance\.accentCustom["']/);
        expect(settingsPanelJs).toMatch(/Settings\.set\(\s*["']appearance\.accent["']\s*,\s*["']custom["']\)/);
    });
});
