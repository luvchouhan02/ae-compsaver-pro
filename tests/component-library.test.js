const fs = require("fs");
const path = require("path");
const Components = require("../js/ui/components");

const css = fs.readFileSync(path.resolve(__dirname, "../css/components.css"), "utf8");
const base = fs.readFileSync(path.resolve(__dirname, "../css/base.css"), "utf8");
const executableCss = css.replace(/\/\*[\s\S]*?\*\//g, "");

function FakeNode(options) {
    options = options || {};
    this.attributes = options.attributes || {};
    this.className = options.className || "";
    this.textContent = options.textContent || "";
    this.disabled = options.disabled === true;
    this.queryMap = options.queryMap || {};
    this.ownerDocument = options.ownerDocument || null;
    const node = this;
    this.classList = {
        add(name) { if (!(new RegExp(`(^|\\s)${name}(\\s|$)`)).test(node.className)) node.className = `${node.className} ${name}`.trim(); },
        remove(name) { node.className = node.className.replace(new RegExp(`(^|\\s)${name}(?=\\s|$)`, "g"), " ").replace(/\s+/g, " ").trim(); }
    };
}
FakeNode.prototype.getAttribute = function (name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; };
FakeNode.prototype.setAttribute = function (name, value) { this.attributes[name] = String(value); };
FakeNode.prototype.removeAttribute = function (name) { delete this.attributes[name]; };
FakeNode.prototype.querySelectorAll = function (selector) { return this.queryMap[selector] || []; };
FakeNode.prototype.contains = function () { return true; };

describe("Foldframe component DOM contracts", () => {
    test("defines every Task 2.3 component type", () => {
        expect(Components.names()).toEqual([
            "button", "field", "select", "toggle", "slider", "segmented", "tabs", "chip",
            "card", "badge", "menu", "dialog", "toast", "tooltip", "placeholder", "state"
        ]);
        Components.names().forEach((name) => expect(Components.contractFor(name).rootClass).toMatch(/^cs-/));
        expect(Components.contractFor("unknown")).toBeNull();
    });

    test("button contract enumerates all applicable interaction and outcome states", () => {
        expect(Components.contractFor("button").states).toEqual([
            "idle", "hover", "active", "focus", "disabled", "busy", "success", "warning", "error"
        ]);
    });

    test("icon-only controls require and receive a programmatic name", () => {
        const button = new FakeNode();
        expect(() => Components.decorateIconButton(button, "")).toThrow("ICON_BUTTON_ACCESSIBLE_NAME_REQUIRED");
        Components.decorateIconButton(button, "Delete preset");
        expect(button.getAttribute("aria-label")).toBe("Delete preset");
        expect(button.getAttribute("data-icon-only")).toBe("true");
        expect(button.className).toContain("cs-btn--icon");
    });

    test("busy state preserves the accessible name and restores operability", () => {
        const button = new FakeNode({ attributes: { "aria-label": "Save template" } });
        Components.setBusy(button, true);
        expect(button.getAttribute("aria-busy")).toBe("true");
        expect(button.getAttribute("data-busy-accessible-name")).toBe("Save template");
        expect(button.getAttribute("aria-label")).toBe("Save template");
        expect(button.disabled).toBe(true);
        Components.setBusy(button, false);
        expect(button.getAttribute("aria-busy")).toBeNull();
        expect(button.disabled).toBe(false);
    });
    test("busy state does not enable a control that was already disabled", () => {
        const button = new FakeNode({ attributes: { "aria-label": "Unavailable" }, disabled: true });
        Components.setBusy(button, true);
        Components.setBusy(button, false);
        expect(button.disabled).toBe(true);
    });

    test("one-primary-action enforcement demotes every prior primary", () => {
        const oldPrimary = new FakeNode({ className: "cs-btn cs-btn--primary", attributes: { "data-variant": "primary", "data-primary-action": "true" } });
        const nextPrimary = new FakeNode({ className: "cs-btn cs-btn--secondary" });
        const selector = ".cs-btn--primary, .cs-btn[data-variant=\"primary\"], .cs-btn[data-primary-action=\"true\"]";
        const region = new FakeNode({ queryMap: { [selector]: [oldPrimary] } });
        Components.setPrimaryAction(region, nextPrimary);
        expect(nextPrimary.getAttribute("data-primary-action")).toBe("true");
        expect(nextPrimary.getAttribute("data-variant")).toBe("primary");
        expect(oldPrimary.getAttribute("data-variant")).toBe("secondary");
        expect(oldPrimary.getAttribute("data-primary-action")).toBeNull();
    });

    test("pressed and selected states use explicit accessibility states", () => {
        const favorite = new FakeNode();
        const tab = new FakeNode();
        Components.setPressed(favorite, true);
        Components.setSelected(tab, true);
        expect(favorite.getAttribute("aria-pressed")).toBe("true");
        expect(tab.getAttribute("aria-selected")).toBe("true");
    });

    test("validator accepts named icon, retained busy name, and explicit states", () => {
        const icon = new FakeNode({ className: "cs-btn--icon", attributes: { "aria-label": "More actions" } });
        const busy = new FakeNode({ attributes: { "aria-label": "Apply", "aria-busy": "true", "data-busy-accessible-name": "Apply" } });
        const toggle = new FakeNode({ className: "cs-toggle", attributes: { "aria-checked": "false" } });
        const tab = new FakeNode({ className: "cs-tab", attributes: { "aria-selected": "true" } });
        const favorite = new FakeNode({ attributes: { "data-favorite": "preset", "aria-pressed": "false" } });
        const root = new FakeNode({
            queryMap: {
                "[data-task-region]": [],
                ".cs-btn--icon, [data-icon-only=\"true\"]": [icon],
                "[aria-busy=\"true\"]": [busy],
                "[data-favorite], .cs-chip, .cs-segment, .cs-tab, .cs-toggle": [toggle, tab, favorite]
            }
        });
        expect(Components.validate(root)).toEqual({ ok: true, errors: [] });
    });

    test("validator fails closed on unnamed icons and missing non-color state attributes", () => {
        const icon = new FakeNode({ className: "cs-btn--icon" });
        const toggle = new FakeNode({ className: "cs-toggle" });
        const root = new FakeNode({
            queryMap: {
                "[data-task-region]": [],
                ".cs-btn--icon, [data-icon-only=\"true\"]": [icon],
                "[aria-busy=\"true\"]": [],
                "[data-favorite], .cs-chip, .cs-segment, .cs-tab, .cs-toggle": [toggle]
            }
        });
        const result = Components.validate(root);
        expect(result.ok).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining(["ICON_BUTTON_ACCESSIBLE_NAME_REQUIRED", "TOGGLE_STATE_REQUIRED"]));
    });
});
describe("Foldframe component CSS contracts", () => {
    const requiredHooks = [
        ".cs-btn", ".cs-field", ".cs-select", ".cs-toggle", ".cs-slider", ".cs-segmented",
        ".cs-tabs", ".cs-chip", ".cs-card", ".cs-badge", ".cs-menu", ".cs-dialog",
        ".cs-toast", ".cs-tooltip", ".cs-placeholder", ".cs-state", ".cs-state--error"
    ];

    test("styles every named reusable component", () => {
        requiredHooks.forEach((hook) => expect(executableCss).toContain(hook));
    });

    test("provides every button hierarchy variant", () => {
        ["primary", "secondary", "tertiary", "icon", "danger"].forEach((variant) => {
            expect(executableCss).toContain(`.cs-btn--${variant}`);
        });
    });

    test("covers hover, active, focus, disabled, and busy interaction states", () => {
        expect(executableCss).toMatch(/\.cs-btn:hover/);
        expect(executableCss).toMatch(/\.cs-btn:active/);
        expect(base).toMatch(/:focus-visible/);
        expect(executableCss).toMatch(/\.cs-btn\[disabled\]/);
        expect(executableCss).toMatch(/\.cs-btn\[aria-busy="true"\]/);
    });

    test("uses non-color cues for selected, favorite, destructive, and semantic states", () => {
        expect(executableCss).toMatch(/aria-selected="true"[\s\S]*content:\s*"✓"/);
        expect(executableCss).toMatch(/data-favorite[\s\S]*content:\s*"★"/);
        expect(executableCss).toMatch(/cs-btn--danger::before[\s\S]*content:\s*"!"/);
        expect(executableCss).toMatch(/data-state="warning"[\s\S]*content:\s*"▲"/);
        expect(executableCss).toMatch(/data-state="error"[\s\S]*content:\s*"!"/);
    });

    test("keeps required card and state actions visible without hover", () => {
        const cardActions = executableCss.match(/\.cs-card__actions\s*\{([^}]*)\}/);
        const stateActions = executableCss.match(/\.cs-state__actions\s*\{([^}]*)\}/);
        expect(cardActions[1]).toMatch(/visibility:\s*visible/);
        expect(cardActions[1]).toMatch(/opacity:\s*1/);
        expect(stateActions[1]).toMatch(/visibility:\s*visible/);
        expect(stateActions[1]).toMatch(/opacity:\s*1/);
    });

    test("has one-primary-action projection and reduced-motion busy/placeholder fallbacks", () => {
        expect(executableCss).toContain("[data-primary-action=\"true\"]");
        expect(executableCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
        expect(executableCss).toMatch(/\.cs-placeholder::after\s*\{[^}]*animation:\s*none/);
    });

    test("contains no unsupported executable CSS or required remote dependency", () => {
        expect(executableCss).not.toMatch(/:has\s*\(|@container\b|@layer\b|color-mix\s*\(/i);
        expect(executableCss).not.toMatch(/https?:\/\//i);
    });
});
