const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Bridge = require("../js/core/bridge");
const Registry = require("../js/core/bridgeRegistry");
const Adapter = require("../js/core/bridgeRegistryAdapter");

function createHarness(overrides) {
    const calls = [];
    const iface = {
        evalScript: function (script, callback) {
            calls.push({ script: script, callback: callback, argumentCount: arguments.length });
            return "legacy-return-token";
        }
    };
    const guardedCalls = [];
    const guardedResult = { exact: "guarded-return-token" };
    const options = Object.assign({
        registry: Registry,
        encodeBridge: Bridge.encodeBridge,
        csInterface: iface,
        callHost: function (script, callOptions) {
            guardedCalls.push({ script: script, options: callOptions });
            return guardedResult;
        }
    }, overrides || {});
    return { adapter: Adapter.create(options), calls, guardedCalls, guardedResult, iface };
}

describe("bridge registry adapter contract", () => {
    test("validates every actual descriptor discriminator and registered inline identity", () => {
        expect(Adapter.schemaVersion).toBe("1.0.0");
        expect(Adapter.validate()).toEqual({ ok: true, errors: [] });
        const inlineDescriptors = Registry.contracts.filter((item) => item.inlineExpressionId);
        expect(inlineDescriptors).toHaveLength(11);
        expect(new Set(Adapter.inlineExpressionIds)).toEqual(new Set(inlineDescriptors.map((item) => item.inlineExpressionId)));
    });

    test("builds named calls with exact identity, count, order, and representation", () => {
        const h = createHarness();
        expect(h.adapter.buildScript("templates.scan", ["A\\Ω\u0000"])).toBe(
            `getAllTemplates("${Bridge.encodeBridge("A\\Ω\u0000")}")`
        );
        expect(h.adapter.buildScript("easing.apply", [12.5, 87])).toBe("toolkitApplyFlow(12.5,87)");
        expect(h.adapter.buildScript("toolkit.crop-precomp", [false])).toBe("toolkitCropPrecomp(false)");
        expect(h.adapter.buildScript("global.ping", [])).toBe("compSaverPing()");
        expect(h.adapter.describe("templates.scan")).toBe(Registry.byId("templates.scan"));
    });

    test("direct callbacks retain raw payloads, asynchronous ownership, and evalScript return shape", () => {
        const h = createHarness();
        const callback = jest.fn();
        const returned = h.adapter.dispatch("effects.validate-selection", [], callback);
        expect(returned).toBe("legacy-return-token");
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].argumentCount).toBe(2);
        expect(h.calls[0].callback).toBe(callback);
        const raw = "\ufeff{\"ok\":true}\r\nEvalScript error.";
        h.calls[0].callback(raw);
        expect(callback).toHaveBeenCalledWith(raw);
        expect(callback).toHaveBeenCalledTimes(1);
    });

    test("callback-free direct calls preserve the one-argument evalScript shape", () => {
        const h = createHarness();
        expect(h.adapter.dispatch("global.debug-eval-file", ["C:/Ext/jsx/compSaver.jsx"])).toBe("legacy-return-token");
        expect(h.calls[0].argumentCount).toBe(1);
        expect(h.calls[0].script).toBe('$.evalFile("C:/Ext/jsx/compSaver.jsx")');
    });

    test("guarded descriptors delegate unchanged to callHost timeout and settlement semantics", () => {
        const h = createHarness();
        const result = h.adapter.dispatch("templates.save.comp", ["N", "C", "R", "O"]);
        expect(result).toBe(h.guardedResult);
        expect(h.guardedCalls).toEqual([{
            script: `saveActiveComp("${Bridge.encodeBridge("N")}","${Bridge.encodeBridge("C")}","${Bridge.encodeBridge("R")}","${Bridge.encodeBridge("O")}")`,
            options: { timeoutMs: 30000, csInterface: h.iface }
        }]);
        expect(h.adapter.describe("templates.save.comp").timeoutPolicy).toEqual({
            policy: "guarded", milliseconds: 30000, nonRejecting: true, lateResponseSuppression: true
        });
    });

    test("the existence probe builds a four-argument encoded call over the guarded transport", () => {
        const h = createHarness();
        const result = h.adapter.dispatch("templates.item-exists", ["My Title", "Titles", "C:/lib", "layer"]);
        // Guarded, not the legacy direct callback: the probe inherits the settled
        // latch, the timeout and the sentinel classification.
        expect(result).toBe(h.guardedResult);
        expect(h.calls).toHaveLength(0);
        expect(h.guardedCalls).toEqual([{
            script: `itemExists("${Bridge.encodeBridge("My Title")}","${Bridge.encodeBridge("Titles")}","${Bridge.encodeBridge("C:/lib")}","${Bridge.encodeBridge("layer")}")`,
            options: { timeoutMs: 30000, csInterface: h.iface }
        }]);
        // The section rides as the fourth encoded argument — a three-argument call
        // is a cardinality error now, not a silent "comp" default.
        expect(() => h.adapter.buildScript("templates.item-exists", ["My Title", "Titles", "C:/lib"]))
            .toThrow("BridgeAdapter:argument-count:templates.item-exists");
        expect(h.adapter.describe("templates.item-exists").successShapes)
            .toEqual(["{exists:Boolean,id?:String,section:String}"]);
    });

    test("registered fixed inline expressions retain their legacy source identity", () => {
        const h = createHarness();
        expect(h.adapter.buildScript("text.default-root", [])).toBe("encodeBridge(getDefaultRootPath())");
        expect(h.adapter.buildScript("text.pick-import-files", [])).toBe("encodeBridge(taPickFfxFiles())");
        expect(h.adapter.buildScript("settings.pick-folder", [])).toBe(
            '(function(){ var f = Folder.selectDialog("Select folder"); return f ? encodeBridge(f.fsName) : ""; })()'
        );
        expect(h.adapter.buildScript("settings.pick-import", [])).toBe(
            '(function(){ var f = File.openDialog("Import Settings", "JSON:*.json"); if (!f) return ""; f.open("r"); var c = f.read(); f.close(); return encodeBridge(c); })()'
        );
        expect(h.adapter.buildScript("global.comp-monitor", [])).toBe('app.project.activeItem ? app.project.activeItem.name : ""');
        expect(h.adapter.buildScript("global.media-picker", ["folder"])).toBe(
            'var f = Folder.selectDialog("Select Media Folder"); if(f) f.fsName; else "";'
        );
        expect(h.adapter.buildScript("global.media-picker", ["file"])).toBe(
            'var f = File.openDialog("Select Media File"); if(f) f.fsName; else "";'
        );
    });

    test("effect inline builders retain sentinel, raw-name, encoded-directory, and raw-pipe contracts", () => {
        const h = createHarness();
        const validation = h.adapter.buildScript("effects.validate-selection", []);
        expect(validation.startsWith("(function() {\n    var comp = app.project.activeItem;")).toBe(true);
        expect(validation.endsWith("return hasEffect ? 'ok' : 'no_effect';\n})();")).toBe(true);
        expect(validation).toContain("return 'no_comp'");
        expect(validation).toContain("return 'no_layer'");
        const detection = h.adapter.buildScript("effects.detect-name", []);
        expect(detection).toContain("if (effect) return effect.name;");
        expect(detection.endsWith("return layer.name;\n})();")).toBe(true);
        const save = h.adapter.buildScript("effects.save", ["O'Brien\\FX", "C:/Presets"]);
        expect(save).toContain("targetEffect.name = 'O\\'Brien\\\\FX';");
        expect(save).toContain(`toolkitSaveEffectPreset("${Bridge.encodeBridge("C:/Presets")}")`);
        expect(save.endsWith("runRenameAndSave();")).toBe(true);
        const picker = h.adapter.buildScript("effects.pick-import-files", []);
        expect(picker).toContain("File.openDialog('Select Presets to Import', 'Presets:*.ffx;*.cseffect', true)");
        expect(picker).toContain("return 'CANCEL'");
        expect(picker).toContain("return paths.join('|')");
        expect(picker.endsWith("runImport();")).toBe(true);
    });

    test("success shapes, decoders, callback policies, and failure sentinels are not normalized", () => {
        const ids = ["templates.save.comp", "effects.validate-selection", "text.apply", "global.comp-monitor"];
        ids.forEach((id) => {
            const before = Registry.byId(id);
            const h = createHarness();
            h.adapter.buildScript(id, before.argumentOrder.map((name, index) => {
                const rep = before.argumentRepresentations[index];
                if (rep === "raw-number") return 1;
                if (rep === "raw-boolean") return true;
                if (rep === "raw-expression-branch") return "file";
                return name;
            }));
            expect(h.adapter.describe(id)).toBe(before);
            expect(h.adapter.describe(id).decoder).toBe(before.decoder);
            expect(h.adapter.describe(id).callbackBehavior).toBe(before.callbackBehavior);
            expect(h.adapter.describe(id).successShapes).toBe(before.successShapes);
            expect(h.adapter.describe(id).failureSentinels).toBe(before.failureSentinels);
        });
    });

    test("unknown schemas, operations, cardinality, representations, and raw types fail closed", () => {
        const h = createHarness();
        expect(() => h.adapter.buildScript("missing", [])).toThrow("BridgeAdapter:unknown-operation:missing");
        expect(() => h.adapter.buildScript("easing.apply", [1])).toThrow("BridgeAdapter:argument-count:easing.apply");
        expect(() => h.adapter.buildScript("easing.apply", ["1", 2])).toThrow("BridgeAdapter:invalid-raw-number:easing.apply:0");
        expect(() => h.adapter.buildScript("toolkit.crop-precomp", [1])).toThrow("BridgeAdapter:invalid-raw-boolean:toolkit.crop-precomp:0");
        expect(() => Adapter.create({ registry: { schemaVersion: "2.0.0", contracts: [] } })).toThrow(
            "BridgeAdapter:registry:unsupported-schema"
        );
        const invalid = Object.assign({}, Registry, {
            contracts: Registry.contracts.concat([Object.assign({}, Registry.contracts[0], {
                id: "invalid-representation", argumentRepresentations: ["mystery"], encoders: ["none"]
            })])
        });
        // Wrap in a thunk: Adapter.create throws at argument-evaluation time,
        // so an unwrapped call escapes expect() before .toThrow can catch it.
        expect(() => Adapter.create({ registry: invalid })).toThrow("BridgeAdapter:bridge[");
    });

    test("classic-script execution exposes an IIFE global without module syntax or initialization calls", () => {
        const source = fs.readFileSync(path.resolve(__dirname, "../js/core/bridgeRegistryAdapter.js"), "utf8");
        const hostCalls = [];
        const sandbox = {
            CompSaverBridgeRegistry: Registry,
            encodeBridge: Bridge.encodeBridge,
            callHost: function () { hostCalls.push(Array.prototype.slice.call(arguments)); },
            csInterface: { evalScript: function () { hostCalls.push(Array.prototype.slice.call(arguments)); } }
        };
        sandbox.window = sandbox;
        vm.runInNewContext(source, sandbox, { filename: "bridgeRegistryAdapter.js" });
        expect(sandbox.CompSaverBridgeAdapter.schemaVersion).toBe("1.0.0");
        expect(sandbox.CompSaverBridgeAdapter.buildScript("easing.apply", [33, 67])).toBe("toolkitApplyFlow(33,67)");
        expect(hostCalls).toEqual([]);
        const executable = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
        expect(executable).not.toMatch(/\b(?:class|async|await|import|export)\b|=>|`/);
    });
});
