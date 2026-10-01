const fs = require("fs");
const path = require("path");
const vm = require("vm");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

function alignmentHost() {
    const layers = [
        { name: "First", bounds: { left: 10, right: 30, top: 20, bottom: 40, cx: 20, cy: 30 } },
        { name: "Second", bounds: { left: 60, right: 100, top: 80, bottom: 100, cx: 80, cy: 90 } }
    ];
    const context = {
        encodeBridge: String, decodeBridge: String, cleanStr: String,
        app: { beginUndoGroup: jest.fn(), endUndoGroup: jest.fn() },
        CameraLayer: function CameraLayer() {}, LightLayer: function LightLayer() {}
    };
    vm.createContext(context);
    vm.runInContext(read("jsx/toolkit.jsx"), context);
    Object.assign(context, {
        toolkitGetActiveComp: () => ({ selectedLayers: layers, width: 200, height: 300, time: 0 }),
        toolkitGetPositionProp: () => ({}), toolkitPropValueAt: () => [0, 0],
        toolkitLayerCompBounds: (layer) => layer.bounds,
        toolkitAddCompDelta: jest.fn(() => true), __alignLog: () => {}
    });
    return context;
}

describe("Workbench alignment scope", () => {
    test.each(["left", "left|comp"])("preserves comp alignment for %s", (mode) => {
        const host = alignmentHost();
        expect(host.toolkitAlignLayers(mode)).toBe("true");
        expect(host.toolkitAddCompDelta.mock.calls.map((call) => call[1][0])).toEqual([-10, -60]);
        expect(host.app.endUndoGroup).toHaveBeenCalledTimes(1);
    });
    test("uses original selection bounds for every layer", () => {
        const host = alignmentHost();
        expect(host.toolkitAlignLayers("right|selection")).toBe("true");
        expect(host.toolkitAddCompDelta.mock.calls.map((call) => call[1][0])).toEqual([70, 0]);
    });
    test("rejects unknown edges without modifying layers", () => {
        const host = alignmentHost();
        expect(host.toolkitAlignLayers("unknown")).toMatch(/Invalid/);
        expect(host.app.beginUndoGroup).not.toHaveBeenCalled();
    });
});

describe("Workbench shell", () => {
    test("partial layer operations warn instead of claiming complete success", () => {
        const source = read("js/toolkit/toolkit.js");
        const host = {};
        vm.createContext(host);
        vm.runInContext(source.slice(source.indexOf("var SILENT_SUCCESS_ACTIONS"), source.indexOf("function toolkitQuietRapidTools")), host);
        expect(host.classifyToolkitResult("oneframer", "Bloom", "OK:Applied to 1 layer; skipped 2 (locked)").kind).toBe("warning");
        expect(host.classifyToolkitResult("oneframer", "Bloom", "OK:Applied to 1 layer").kind).toBe("success");
        expect(host.toolkitActionLabel("oneframer")).toBe("Apply One-Framer");
    });
    test("renders cached One-Framers when Effects mounts after the palette", async () => {
        const catalog = JSON.parse(read("presets/oneframers_106_recipes.json"));
        const element = () => ({ style: {}, setAttribute: jest.fn(), appendChild: jest.fn() });
        const grid = element();
        const count = element();
        let mounted = false;
        const host = {
            localStorage: { getItem: () => null },
            Settings: { onChange: jest.fn() },
            fetch: jest.fn(async () => ({ ok: true, json: async () => catalog })),
            document: {
                getElementById: (id) => mounted ? (id === "cs-oneframer-grid" ? grid : count) : null,
                createElement: element, createDocumentFragment: element
            }
        };
        vm.createContext(host);
        vm.runInContext(read("js/toolkit/effects.js"), host);
        await host.OneFramers.load();
        expect(grid.appendChild).not.toHaveBeenCalled();
        mounted = true;
        await host.OneFramers.load();
        expect(grid.appendChild).toHaveBeenCalledTimes(1);
        expect(count.textContent).toBe("106 / 106");
        expect(host.fetch).toHaveBeenCalledTimes(1);
    });
    test("palette discovers real tool controls and live text presets", () => {
        const click = jest.fn();
        const control = { id: "", disabled: false, textContent: "Reverse video", getAttribute: (name) => name === "data-toolkit-action" ? "reverse-video" : null, closest: () => ({ id: "cs-wb-panel-velocity" }), click };
        const host = { document: { querySelectorAll: () => [control, control] }, TextAnim: { getPresets: () => [{ path: "C:/Title.ffx", displayName: "Title" }], applyPreset: jest.fn() } };
        vm.createContext(host);
        vm.runInContext(read("js/ui/command-palette.js"), host);
        const commands = host.CommandPalette.getCommands();
        const reverse = commands.filter((command) => command.id === "tool:reverse-video:");
        expect(reverse).toHaveLength(1);
        reverse[0].run();
        expect(click).toHaveBeenCalledTimes(1);
        commands.find((command) => command.id === "text:C:/Title.ffx").run();
        expect(host.TextAnim.applyPreset).toHaveBeenCalledWith("C:/Title.ffx");
        host.OneFramers = { getRecipes: () => JSON.parse(read("presets/oneframers_106_recipes.json")), apply: jest.fn() };
        const recipes = host.CommandPalette.getCommands().filter((command) => command.category === "ONE-FRAMER");
        expect(recipes).toHaveLength(106);
        recipes[0].run();
        expect(host.OneFramers.apply).toHaveBeenCalledWith("Aberration");
        const search = { dispatchEvent: jest.fn(), focus: jest.fn() };
        Object.assign(host, {
            allTemplates: [{ id: "title", name: "Title", section: "text", category: "Titles" }],
            getTemplateSection: (template) => template.section,
            switchMainModule: jest.fn(), switchSection: jest.fn(), MODULES: { TEMPLATES: "templates" },
            Event: function Event(type) { this.type = type; }
        });
        host.document.getElementById = () => search;
        host.CommandPalette.getCommands().find((command) => command.id === "template:title").run();
        expect(host.switchSection).toHaveBeenCalledWith("text");
        expect(search.value).toBe("Title");
        expect(search.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "input" }));
        expect(search.focus).toHaveBeenCalledTimes(1);
    });
    test("loads the controller once before main startup", () => {
        const shell = read("index.html");
        expect(shell.match(/src="js\/ui\/toolkit-workbench.js/g)).toHaveLength(1);
        expect(shell.indexOf("js/ui/toolkit-workbench.js")).toBeLessThan(shell.indexOf("js/main.js"));
        expect(shell.split(/\r?\n/).length).toBeLessThan(300);
    });
    test("names the crop action and sequence controls", () => {
        const markup = read("views/tools.html");
        expect(markup).toMatch(/id="btn-tk-crop-execute"[^>]*aria-label="Crop Precomp"/);
        for (const label of ["Decrease sequence group size", "Increase sequence group size", "Decrease frame offset", "Increase frame offset", "Sequence group size", "Frame offset"]) {
            expect(markup).toContain('aria-label="' + label + '"');
        }
    });
    test("declares four uniquely identified tab panels", () => {
        const markup = read("views/tools.html");
        for (const tab of ["layout", "velocity", "text", "guides"]) {
            expect(markup.match(new RegExp('id="cs-wb-panel-' + tab + '"', "g"))).toHaveLength(1);
            expect(markup).toContain('aria-controls="cs-wb-panel-' + tab + '"');
        }
    });
});

function workbenchHost(layers) {
    function CompItem() {}
    function AVLayer() {}
    function ShapeLayer() {}
    function TextLayer() {}
    const comp = Object.assign(new CompItem(), { selectedLayers: layers || [], width: 200, height: 300, time: 1, frameDuration: 1 / 30 });
    const host = { CompItem, AVLayer, ShapeLayer, TextLayer, encodeBridge: String, decodeBridge: String,
        jsonStringify: JSON.stringify,
        app: { project: { activeItem: comp }, beginUndoGroup: jest.fn(), endUndoGroup: jest.fn() }
    };
    vm.createContext(host);
    vm.runInContext("var jsonParse = JSON.parse;", host);
    vm.runInContext(read("jsx/workbench.jsx"), host);
    return host;
}

describe("Workbench host operations", () => {
    test.each(["ShapeLayer", "TextLayer"])("blends native %s without AVLayer inheritance", (type) => {
        const host = workbenchHost();
        const layer = new host[type]();
        host.BlendingMode = { SCREEN: 42 };
        host.app.project.activeItem.selectedLayers = [layer];
        expect(layer instanceof host.AVLayer).toBe(false);
        expect(host.toolkitBatchBlendMode("SCREEN")).toMatch(/^OK:/);
        expect(layer.blendingMode).toBe(42);
    });
    test.each([0, 0.25])("remap replacement retains an active key with first target at %s", (firstTime) => {
        const host = workbenchHost();
        const entries = [{ time: 0, value: 0 }, { time: 4, value: 4 }];
        const remap = {
            get numKeys() { return entries.length; },
            keyTime: (index) => entries[index - 1].time,
            removeKey: (index) => { entries.splice(index - 1, 1); expect(entries.length).toBeGreaterThan(0); },
            nearestKeyIndex: (time) => entries.findIndex((entry) => Math.abs(entry.time - time) < 1e-7) + 1,
            setValueAtTime: (time, value) => {
                if (!entries.length) throw new Error("Time Remap is hidden");
                const existing = entries.find((entry) => entry.time === time);
                if (existing) existing.value = value;
                else entries.push({ time, value });
                entries.sort((left, right) => left.time - right.time);
            }
        };
        const expected = [{ time: firstTime, value: 3 }, { time: 3, value: 0 }];
        host.csWorkbenchReplaceRemapKeys(remap, expected);
        expect(entries).toEqual(expected);
    });
    test("text isolation uses native selector property match names", () => {
        const host = workbenchHost();
        const values = {};
        const property = (name) => ({ setValue: (value) => { values[name] = value; } });
        const advanced = { property: (name) => ["ADBE Text Range Units", "ADBE Text Selector Smoothness"].includes(name) ? property(name) : null };
        const selector = { property: (name) => name === "ADBE Text Range Advanced" ? advanced : property(name) };
        host.csWorkbenchHideTextRange({ addProperty: () => selector }, 4, 7);
        expect(values).toEqual({ "ADBE Text Range Units": 2, "ADBE Text Selector Smoothness": 0, "ADBE Text Index Start": 4, "ADBE Text Index End": 7 });
    });
    test("Reel guide inserts once and stays locked and non-rendering when toggled", () => {
        const host = workbenchHost();
        const layers = [];
        const properties = {};
        const guide = { property: () => ({ property: (name) => properties[name] || (properties[name] = { setValue: jest.fn() }) }), moveToBeginning: jest.fn() };
        Object.assign(host.app.project.activeItem, {
            duration: 6, layer: (index) => layers[index - 1],
            layers: { add: jest.fn(() => { guide.enabled = true; layers.push(guide); return guide; }) }
        });
        Object.defineProperty(host.app.project.activeItem, "numLayers", { get: () => layers.length });
        host.File = function File(filePath) { this.fsName = filePath; this.exists = true; };
        host.ImportOptions = function ImportOptions(file) { this.file = file; };
        host.FootageItem = function FootageItem() {};
        host.app.project.importFile = jest.fn(() => ({ width: 1080, height: 1920 }));
        expect(host.toolkitToggleIGReelGuide("guide.png")).toContain("enabled");
        expect(guide.locked).toBe(true);
        expect(guide.guideLayer).toBe(true);
        expect(guide.outPoint).toBe(6);
        expect(properties["ADBE Position"].setValue).toHaveBeenCalledWith([100, 150]);
        expect(host.toolkitToggleIGReelGuide("guide.png")).toContain("hidden");
        expect(host.toolkitToggleIGReelGuide("guide.png")).toContain("enabled");
        expect(host.app.project.importFile).toHaveBeenCalledTimes(1);
        expect(layers).toHaveLength(1);
        expect(guide.locked).toBe(true);
        expect(host.app.beginUndoGroup).toHaveBeenCalledTimes(3);
        expect(host.app.endUndoGroup).toHaveBeenCalledTimes(3);
    });
    test("Reel guide rejects missing assets without importing", () => {
        const host = workbenchHost();
        host.File = function File() { this.exists = false; };
        host.app.project.importFile = jest.fn();
        expect(host.toolkitToggleIGReelGuide("missing.png")).toMatch(/^PRE:guide-asset:/);
        expect(host.app.project.importFile).not.toHaveBeenCalled();
        expect(host.app.endUndoGroup).toHaveBeenCalledTimes(1);
    });
    test("One-Framers preflight plugins before adding any effects", () => {
        const host = workbenchHost();
        const effects = { canAddProperty: (name) => name === "ADBE Sharpen", addProperty: jest.fn() };
        const layer = Object.assign(new host.AVLayer(), { property: () => effects });
        host.app.project.activeItem.selectedLayers = [layer];
        const recipe = { name: "Requires plugin", effects: [{ mn: "ADBE Sharpen", p: [] }, { mn: ["Missing.Plugin"], p: [] }] };
        expect(host.toolkitApplyOneFramer(JSON.stringify(recipe))).toContain("Missing effect/plugin");
        expect(effects.addProperty).not.toHaveBeenCalled();
        expect(host.app.endUndoGroup).toHaveBeenCalledTimes(1);
    });
    test.each(["AVLayer", "ShapeLayer", "TextLayer"])("One-Framers resolve aliases and roll back invalid parameter writes on %s", (type) => {
        const host = workbenchHost();
        const entries = [{ existing: true }];
        const values = [];
        const effects = {
            get numProperties() { return entries.length; },
            canAddProperty: (name) => name === "Installed.Plugin",
            addProperty: () => { const effect = { property: (index) => index === 1 ? { setValue: (value) => values.push(value) } : null, remove: () => entries.pop() }; entries.push(effect); return effect; },
            property: (index) => entries[index - 1]
        };
        const layer = Object.assign(new host[type](), { property: () => effects, blendingMode: "normal" });
        host.app.project.activeItem.selectedLayers = [layer];
        const recipe = { name: "Alias", effects: [{ mn: ["Missing", "Installed.Plugin"], p: [[1, 20]] }] };
        expect(host.toolkitApplyOneFramer(JSON.stringify(recipe))).toMatch(/^OK:/);
        expect(values).toEqual([20]);
        recipe.effects[0].p = [[99, 30]];
        expect(host.toolkitApplyOneFramer(JSON.stringify(recipe))).toContain("Recipe not applied");
        expect(entries).toHaveLength(2);
        expect(entries[0]).toEqual({ existing: true });
    });
    test("detects inherited expressions in nested layer properties", () => {
        const host = workbenchHost();
        const expression = { expressionEnabled: true };
        const group = { numProperties: 1, property: () => expression };
        expect(host.csWorkbenchHasExpression({ numProperties: 1, property: () => group })).toBe(true);
        expression.expressionEnabled = false;
        expect(host.csWorkbenchHasExpression(group)).toBe(false);
    });
    test.each([false, true])("text background resets parent compensation in 3D=%s", (threeDLayer) => {
        const host = workbenchHost();
        host.TextLayer = function TextLayer() {};
        const text = Object.assign(new host.TextLayer(), { name: "Title", threeDLayer, inPoint: 0, outPoint: 3 });
        const properties = {};
        const property = (name) => properties[name] || (properties[name] = { setValue: jest.fn() });
        const shape = { property: () => ({ property, addProperty: () => ({ property }) }), moveAfter: jest.fn() };
        const contents = { addProperty: jest.fn(), property: () => ({ property }) };
        shape.property = (name) => name === "ADBE Root Vectors Group" ? contents : { property, addProperty: () => ({ property }) };
        host.app.project.activeItem.selectedLayers = [text];
        host.app.project.activeItem.layers = { addShape: () => shape };
        expect(host.toolkitCreateResponsiveTextBox()).toMatch(/^OK:/);
        expect(properties["ADBE Scale"].setValue).toHaveBeenCalledWith(threeDLayer ? [100, 100, 100] : [100, 100]);
        expect(properties["ADBE Rotate Z"].setValue).toHaveBeenCalledWith(0);
        expect(shape.parent).toBe(text);
    });
    test("find and replace treats metacharacters and dollar signs literally", () => {
        const host = workbenchHost();
        expect(host.csWorkbenchReplaceLiteral("A+B a+b", "a+b", "$&", false)).toBe("$& $&");
        expect(host.csWorkbenchReplaceLiteral("A+B a+b", "a+b", "new", true)).toBe("A+B new");
    });
    test("text ranges retain spacing and line offsets", () => {
        const host = workbenchHost();
        expect(host.csWorkbenchTextRanges("One  two\rThree", "words")).toEqual([
            { start: 0, end: 3, text: "One" }, { start: 5, end: 8, text: "two" }, { start: 9, end: 14, text: "Three" }
        ]);
        expect(host.csWorkbenchTextRanges("\ud83d\ude00 A", "letters")).toEqual([
            { start: 0, end: 2, text: "\ud83d\ude00" }, { start: 3, end: 4, text: "A" }
        ]);
    });
    test("validates before opening an undo group", () => {
        const host = workbenchHost();
        expect(host.toolkitMirrorLayers("h")).toMatch(/^PRE:/);
        expect(host.toolkitSetAspectRatio("bogus")).toMatch(/Invalid/);
        expect(host.app.beginUndoGroup).not.toHaveBeenCalled();
    });
    test.each([["9:16", 1080, 1920], ["16:9", 1920, 1080], ["1:1", 1080, 1080], ["4:5", 1080, 1350]])("resizes %s", (ratio, width, height) => {
        const host = workbenchHost();
        expect(host.toolkitSetAspectRatio(ratio)).toMatch(/^OK:/);
        expect(host.app.project.activeItem).toMatchObject({ width, height });
        expect(host.app.endUndoGroup).toHaveBeenCalledTimes(1);
    });
    test("closes undo group when an operation throws", () => {
        const host = workbenchHost();
        expect(host.csWorkbenchRun("Failure", false, () => { throw new Error("test"); })).toContain("Undo to restore");
        expect(host.app.endUndoGroup).toHaveBeenCalledTimes(1);
    });
    test("splits only eligible layers while preserving source timing", () => {
        const right = {};
        const source = { inPoint: 0, outPoint: 4, duplicate: jest.fn(() => right) };
        const locked = { inPoint: 0, outPoint: 4, locked: true, duplicate: jest.fn() };
        const host = workbenchHost([source, locked]);
        expect(host.toolkitSplitAtPlayhead()).toContain("skipped 1");
        expect(source.outPoint).toBe(1);
        expect(right.inPoint).toBe(1);
        expect(locked.duplicate).not.toHaveBeenCalled();
    });
    test("mirrors every Scale key without losing the third dimension", () => {
        const scale = { numKeys: 2, keyValue: () => [100, 80, 50], setValueAtKey: jest.fn() };
        const host = workbenchHost([{ property: () => ({ property: () => scale }) }]);
        expect(host.toolkitMirrorLayers("h")).toMatch(/^OK:/);
        expect(scale.setValueAtKey.mock.calls).toEqual([[1, [-100, 80, 50]], [2, [-100, 80, 50]]]);
    });
});