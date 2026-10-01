/* CompSaver bridge-registry dispatch adapter. Delegates without changing host semantics. */
(function (root) {
    "use strict";

    var nodeRegistry = null;
    var nodeBridge = null;
    if (typeof module !== "undefined" && module.exports) {
        nodeRegistry = require("./bridgeRegistry");
        nodeBridge = require("./bridge");
    }

    var SUPPORTED_TRANSPORTS = { "legacy-callback": true, "guarded-callHost": true };
    var SUPPORTED_REPRESENTATIONS = {
        "hex-utf16": true,
        "raw-number": true,
        "raw-boolean": true,
        "escaped-raw-js-string": true,
        "raw-expression-branch": true
    };

    function fail(code) { throw new Error("BridgeAdapter:" + code); }
    function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
    function copy(values) { return values ? values.slice(0) : []; }
    function doubleQuoted(value) {
        return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
            .replace(/\r/g, "\\r").replace(/\n/g, "\\n")
            .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029") + '"';
    }
    function effectNameLiteral(value) {
        return "'" + String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
    }

    var INLINE_EXPRESSIONS = {
        "effects.selection-validation-v1": {
            argumentOrder: [], build: function () {
                return "(function() {\n" +
                    "    var comp = app.project.activeItem;\n" +
                    "    if (!comp || !(comp instanceof CompItem)) return 'no_comp';\n" +
                    "    var sel = comp.selectedLayers;\n" +
                    "    if (!sel || sel.length !== 1) return 'no_layer';\n" +
                    "    var layer = sel[0];\n" +
                    "    var selProps = [];\n" +
                    "    try { selProps = layer.selectedProperties; } catch(e) {}\n" +
                    "    if (!selProps || selProps.length === 0) return 'no_effect';\n" +
                    "    var hasEffect = false;\n" +
                    "    for (var i = 0; i < selProps.length; i++) {\n" +
                    "        var p = selProps[i];\n" +
                    "        while (p && p.parentProperty && p.parentProperty.matchName !== 'ADBE Effect Parade') {\n" +
                    "            p = p.parentProperty;\n" +
                    "        }\n" +
                    "        if (p && p.parentProperty && p.parentProperty.matchName === 'ADBE Effect Parade') {\n" +
                    "            hasEffect = true;\n" +
                    "            break;\n" +
                    "        }\n" +
                    "    }\n" +
                    "    return hasEffect ? 'ok' : 'no_effect';\n" +
                    "})();";
            }
        },
        "effects.detect-selected-name-v1": {
            argumentOrder: [], build: function () {
                return "(function() {\n" +
                    "    var comp = app.project.activeItem;\n" +
                    "    if (!comp || !(comp instanceof CompItem)) return '';\n" +
                    "    var sel = comp.selectedLayers;\n" +
                    "    if (!sel || sel.length !== 1) return '';\n" +
                    "    var layer = sel[0];\n" +
                    "    var effect = null;\n" +
                    "    try {\n" +
                    "        var selProps = layer.selectedProperties;\n" +
                    "        if (selProps && selProps.length > 0) {\n" +
                    "            var p = selProps[0];\n" +
                    "            while (p && p.parentProperty && p.parentProperty.matchName !== 'ADBE Effect Parade') {\n" +
                    "                p = p.parentProperty;\n" +
                    "            }\n" +
                    "            if (p && p.parentProperty && p.parentProperty.matchName === 'ADBE Effect Parade') {\n" +
                    "                effect = p;\n" +
                    "            }\n" +
                    "        }\n" +
                    "    } catch(e) {}\n" +
                    "    if (effect) return effect.name;\n" +
                    "    return layer.name;\n" +
                    "})();";
            }
        },
        "effects.rename-save-restore-v1": {
            argumentOrder: ["customName", "targetDir"], build: function (args, encode) {
                return "function runRenameAndSave() {\n" +
                    "    var comp = app.project.activeItem;\n" +
                    "    if (!comp || !(comp instanceof CompItem)) return '{\"ok\":false,\"error\":\"Open a composition first\"}';\n" +
                    "    var sel = comp.selectedLayers;\n" +
                    "    if (!sel || sel.length !== 1) return '{\"ok\":false,\"error\":\"Select exactly one layer\"}';\n" +
                    "    var layer = sel[0];\n" +
                    "    var targetEffect = getTargetEffectForSave();\n" +
                    "    if (!targetEffect) return '{\"ok\":false,\"error\":\"Select an effect in Effect Controls\"}';\n" +
                    "    var origName = targetEffect.name;\n" +
                    "    targetEffect.name = " + effectNameLiteral(args[0]) + ";\n" +
                    "    var saveResult = toolkitSaveEffectPreset(" + doubleQuoted(encode(args[1])) + ");\n" +
                    "    targetEffect.name = origName;\n" +
                    "    return saveResult;\n" +
                    "}\n" +
                    "runRenameAndSave();";
            }
        },
        "effects.open-dialog-multi-v1": {
            argumentOrder: [], build: function () {
                return "function runImport() {\n" +
                    "    var files = File.openDialog('Select Presets to Import', 'Presets:*.ffx;*.cseffect', true);\n" +
                    "    if (!files) return 'CANCEL';\n" +
                    "    var paths = [];\n" +
                    "    if (files instanceof Array) {\n" +
                    "        for (var i = 0; i < files.length; i++) { paths.push(files[i].fsName); }\n" +
                    "    } else {\n" +
                    "        paths.push(files.fsName);\n" +
                    "    }\n" +
                    "    return paths.join('|');\n" +
                    "}\n" +
                    "runImport();";
            }
        },
        "encodeBridge-getDefaultRootPath-v1": { argumentOrder: [], build: function () { return "encodeBridge(getDefaultRootPath())"; } },
        "encodeBridge-taPickFfxFiles-v1": { argumentOrder: [], build: function () { return "encodeBridge(taPickFfxFiles())"; } },
        "settings-folder-select-v1": { argumentOrder: [], build: function () { return '(function(){ var f = Folder.selectDialog("Select folder"); return f ? encodeBridge(f.fsName) : ""; })()'; } },
        "settings-json-open-read-v1": { argumentOrder: [], build: function () { return '(function(){ var f = File.openDialog("Import Settings", "JSON:*.json"); if (!f) return ""; f.open("r"); var c = f.read(); f.close(); return encodeBridge(c); })()'; } },
        "active-comp-name-raw-v1": { argumentOrder: [], build: function () { return 'app.project.activeItem ? app.project.activeItem.name : ""'; } },
        "media-open-dialog-v1": {
            argumentOrder: ["mediaType"], build: function (args) {
                return args[0] === true || args[0] === "folder" ?
                    'var f = Folder.selectDialog("Select Media Folder"); if(f) f.fsName; else "";' :
                    'var f = File.openDialog("Select Media File"); if(f) f.fsName; else "";';
            }
        },
        "debug-dollar-evalFile-v1": { argumentOrder: ["jsxPath"], build: function (args) { return "$.evalFile(" + doubleQuoted(args[0]) + ")"; } }
    };

    function validateRegistry(registry) {
        var errors = [];
        if (!registry || registry.schemaVersion !== "1.0.0" || !Array.isArray(registry.contracts)) {
            return { ok: false, errors: ["registry:unsupported-schema"] };
        }
        if (!registry.validate || registry.validate(registry.contracts).ok !== true) errors.push("registry:invalid-contracts");
        for (var i = 0; i < registry.contracts.length; i++) {
            var descriptor = registry.contracts[i];
            var prefix = "bridge[" + i + "]";
            if (!SUPPORTED_TRANSPORTS[descriptor.transportPolicy]) errors.push(prefix + ":unknown-transport:" + descriptor.transportPolicy);
            for (var r = 0; r < descriptor.argumentRepresentations.length; r++) {
                if (!SUPPORTED_REPRESENTATIONS[descriptor.argumentRepresentations[r]]) {
                    errors.push(prefix + ":unknown-representation:" + descriptor.argumentRepresentations[r]);
                }
                var expectedEncoder = descriptor.argumentRepresentations[r] === "hex-utf16" ? "encodeBridge" : "none";
                if (descriptor.encoders[r] !== expectedEncoder) errors.push(prefix + ":encoder-mismatch:" + r);
            }
            if (descriptor.inlineExpressionId) {
                var inline = INLINE_EXPRESSIONS[descriptor.inlineExpressionId];
                if (!inline) errors.push(prefix + ":unknown-inline-expression:" + descriptor.inlineExpressionId);
                else if (inline.argumentOrder.join("\u0000") !== descriptor.argumentOrder.join("\u0000")) {
                    errors.push(prefix + ":inline-argument-order-mismatch");
                }
            } else if (!descriptor.hostFunction) {
                errors.push(prefix + ":missing-host-function");
            }
            if (descriptor.transportPolicy === "guarded-callHost" &&
                (!descriptor.timeoutPolicy || descriptor.timeoutPolicy.policy !== "guarded" ||
                    descriptor.timeoutPolicy.nonRejecting !== true || descriptor.timeoutPolicy.lateResponseSuppression !== true)) {
                errors.push(prefix + ":guarded-policy-mismatch");
            }
        }
        return { ok: errors.length === 0, errors: errors };
    }

    function createAdapter(options) {
        options = options || {};
        var registry = options.registry || nodeRegistry || root.CompSaverBridgeRegistry;
        var encode = options.encodeBridge || (nodeBridge && nodeBridge.encodeBridge) || root.encodeBridge;
        var guardedCall = options.callHost || (nodeBridge && nodeBridge.callHost) || root.callHost;
        var iface = options.csInterface || root.csInterface || null;
        var registryResult = validateRegistry(registry);
        if (!registryResult.ok) fail(registryResult.errors[0]);

        function describe(id) { return registry.byId(id); }
        function requireDescriptor(id, args) {
            var descriptor = describe(id);
            if (!descriptor) fail("unknown-operation:" + id);
            if (!Array.isArray(args)) fail("arguments-not-array:" + id);
            if (args.length !== descriptor.argumentOrder.length) {
                fail("argument-count:" + id + ":expected-" + descriptor.argumentOrder.length + ":received-" + args.length);
            }
            return descriptor;
        }
        function formatNamedArgument(representation, value, id, index) {
            if (representation === "hex-utf16") {
                if (typeof encode !== "function") fail("codec-unavailable:" + id);
                return doubleQuoted(encode(value));
            }
            if (representation === "raw-number") {
                if (typeof value !== "number" || !isFinite(value)) fail("invalid-raw-number:" + id + ":" + index);
                return String(value);
            }
            if (representation === "raw-boolean") {
                if (value !== true && value !== false) fail("invalid-raw-boolean:" + id + ":" + index);
                return value ? "true" : "false";
            }
            fail("inline-only-representation:" + representation + ":" + id);
        }
        function buildScript(id, args) {
            args = typeof args === "undefined" ? [] : args;
            var descriptor = requireDescriptor(id, args);
            if (descriptor.inlineExpressionId) {
                if (!own(INLINE_EXPRESSIONS, descriptor.inlineExpressionId)) fail("unknown-inline-expression:" + descriptor.inlineExpressionId);
                if (descriptor.argumentRepresentations.indexOf("hex-utf16") !== -1 && typeof encode !== "function") fail("codec-unavailable:" + id);
                return INLINE_EXPRESSIONS[descriptor.inlineExpressionId].build(copy(args), encode);
            }
            var rendered = [];
            for (var i = 0; i < args.length; i++) {
                rendered.push(formatNamedArgument(descriptor.argumentRepresentations[i], args[i], id, i));
            }
            return descriptor.hostFunction + "(" + rendered.join(",") + ")";
        }
        function dispatch(id, args, callback) {
            var descriptor = requireDescriptor(id, typeof args === "undefined" ? [] : args);
            var script = buildScript(id, typeof args === "undefined" ? [] : args);
            if (descriptor.transportPolicy === "guarded-callHost") {
                if (typeof guardedCall !== "function") fail("guarded-callHost-unavailable:" + id);
                var guardedOptions = { timeoutMs: descriptor.timeoutPolicy.milliseconds };
                if (iface) guardedOptions.csInterface = iface;
                return guardedCall(script, guardedOptions);
            }
            if (!iface || typeof iface.evalScript !== "function") fail("legacy-transport-unavailable:" + id);
            if (typeof callback === "function") return iface.evalScript(script, callback);
            return iface.evalScript(script);
        }
        return {
            schemaVersion: "1.0.0",
            registrySchemaVersion: registry.schemaVersion,
            describe: describe,
            buildScript: buildScript,
            dispatch: dispatch,
            validate: function () { return validateRegistry(registry); }
        };
    }

    var defaultAdapter = createAdapter({});
    var api = {
        schemaVersion: "1.0.0",
        inlineExpressionIds: Object.keys(INLINE_EXPRESSIONS),
        create: createAdapter,
        validate: function () { return defaultAdapter.validate(); },
        describe: function (id) { return defaultAdapter.describe(id); },
        buildScript: function (id, args) { return defaultAdapter.buildScript(id, args); },
        dispatch: function (id, args, callback) { return defaultAdapter.dispatch(id, args, callback); }
    };
    if (typeof Object.freeze === "function") {
        Object.freeze(api.inlineExpressionIds);
        Object.freeze(api);
    }
    root.CompSaverBridgeAdapter = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof window !== "undefined" ? window : this));
