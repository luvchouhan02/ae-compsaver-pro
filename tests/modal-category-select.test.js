const fs = require("fs");
const path = require("path");
const vm = require("vm");
const SA = require("./helpers/static-analysis");

function categoryHarness() {
    const context = { DOM: {} };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/ui/modals.js"), "utf8"), context);
    const handlers = {};
    const attributes = {};
    const classes = new Set();
    const trigger = {
        addEventListener: (name, callback) => { handlers["trigger:" + name] = callback; },
        setAttribute: (name, value) => { attributes[name] = value; },
        focus: jest.fn()
    };
    const options = [{ focus: jest.fn() }, { focus: jest.fn() }];
    const wrapper = {
        classList: {
            contains: name => classes.has(name),
            toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
        },
        querySelector: () => trigger,
        querySelectorAll: () => options,
        addEventListener: (name, callback) => { handlers["wrapper:" + name] = callback; }
    };
    context.DOM["cat-select-wrapper"] = wrapper;
    context.bindCategorySelect(trigger, wrapper);
    const key = (name, target = trigger) => {
        const event = { key: name, target, preventDefault: jest.fn(), stopPropagation: jest.fn() };
        handlers["wrapper:keydown"](event);
        return event;
    };
    return { context, handlers, attributes, classes, trigger, options, wrapper, key };
}

describe("Modal category disclosure", () => {
    test("Save and Move triggers are named native buttons with controlled menus", () => {
        const markup = SA.composeMarkup();
        for (const prefix of ["cat-select", "move-cat-select"]) {
            const tag = markup.match(new RegExp('<button[^>]*id="' + prefix + '-trigger"[^>]*>'));
            expect(tag).not.toBeNull();
            expect(tag[0]).toContain('type="button"');
            expect(tag[0]).toContain('aria-label="');
            expect(tag[0]).toContain('aria-expanded="false"');
            expect(tag[0]).toContain('aria-controls="' + prefix + '-dropdown"');
        }
    });

    test("click toggles the visual and accessible open states together", () => {
        const harness = categoryHarness();
        const event = { stopPropagation: jest.fn() };
        harness.handlers["trigger:click"](event);
        expect(harness.classes.has("open")).toBe(true);
        expect(harness.attributes["aria-expanded"]).toBe("true");
        harness.handlers["trigger:click"](event);
        expect(harness.classes.has("open")).toBe(false);
        expect(harness.attributes["aria-expanded"]).toBe("false");
    });

    test("arrows open the menu and wrap between options", () => {
        const harness = categoryHarness();
        harness.key("ArrowDown");
        expect(harness.attributes["aria-expanded"]).toBe("true");
        expect(harness.options[0].focus).toHaveBeenCalledTimes(1);
        harness.key("ArrowUp", harness.options[0]);
        expect(harness.options[1].focus).toHaveBeenCalledTimes(1);
        harness.key("ArrowDown", harness.options[1]);
        expect(harness.options[0].focus).toHaveBeenCalledTimes(2);
    });

    test("Escape closes the menu, restores focus and does not dismiss the parent dialog", () => {
        const harness = categoryHarness();
        harness.key("ArrowDown");
        const event = harness.key("Escape", harness.options[0]);
        expect(harness.attributes["aria-expanded"]).toBe("false");
        expect(harness.trigger.focus).toHaveBeenCalledTimes(1);
        expect(event.stopPropagation).toHaveBeenCalledTimes(1);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(harness.key("Escape").stopPropagation).not.toHaveBeenCalled();
    });

    test("an empty destination menu does not intercept arrow keys or throw", () => {
        const harness = categoryHarness();
        harness.options.length = 0;
        expect(harness.key("ArrowDown").preventDefault).not.toHaveBeenCalled();
        expect(harness.classes.has("open")).toBe(false);
    });
});