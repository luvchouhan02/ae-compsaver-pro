/* CompSaver baseline bridge-contract registry. Data only: no dispatch semantics. */
(function (root) {
    "use strict";

    var ERROR_SENTINELS = ["", "EvalScript error.", "undefined"];
    var DIRECT_TIMEOUT = { policy: "none", milliseconds: null, nonRejecting: false, lateResponseSuppression: false };
    var GUARDED_TIMEOUT = { policy: "guarded", milliseconds: 30000, nonRejecting: true, lateResponseSuppression: true };
    var PREVIEW_TIMEOUT = { policy: "queue-budget", milliseconds: 60000, nonRejecting: false, lateResponseSuppression: true };
    // Calls dispatched through js/core/toolBridge.js (ToolBridge.call). ToolBridge
    // bounds every call with a timer (DEFAULT_TIMEOUT_MS = 30000), routes success,
    // host-error, timeout and disposal through ONE finalizer, never rejects, and
    // suppresses a late/duplicate evalScript callback via its settled latch.
    // Toolkit contracts previously declared DIRECT_TIMEOUT ({policy:"none"}),
    // which no longer described the runtime behaviour.
    var TOOL_BRIDGE_TIMEOUT = { policy: "tool-bridge", milliseconds: 30000, nonRejecting: true, lateResponseSuppression: true };
    // Some Toolkit call sites raise the bound with an explicit `timeoutMs`,
    // because the host work legitimately exceeds 30 s (crop bounds sampling,
    // clipboard image decode + import). Mirror that number here so the contract
    // matches the call site instead of the default.
    function toolBridgeTimeout(milliseconds) {
        return { policy: "tool-bridge", milliseconds: milliseconds, nonRejecting: true, lateResponseSuppression: true };
    }
    var contracts = [];

    function clone(values) { return values ? values.slice(0) : []; }
    function add(id, hostFunction, args, reps, decoder, success, failures, source, options) {
        options = options || {};
        contracts.push({
            id: id,
            hostFunction: hostFunction || null,
            inlineExpressionId: options.inlineExpressionId || null,
            transportPolicy: options.transportPolicy || "legacy-callback",
            argumentOrder: clone(args),
            argumentRepresentations: clone(reps),
            encoders: clone(reps).map(function (rep) { return rep === "hex-utf16" ? "encodeBridge" : "none"; }),
            decoder: decoder,
            timeoutPolicy: options.timeoutPolicy || DIRECT_TIMEOUT,
            callbackBehavior: options.callbackBehavior || "asynchronous-single-callback",
            successShapes: clone(success),
            failureSentinels: clone(failures || ERROR_SENTINELS),
            source: source
        });
    }

    function addEncoded(id, fn, args, decoder, success, source, failures, options) {
        add(id, fn, args, args.map(function () { return "hex-utf16"; }), decoder, success, failures, source, options);
    }
    addEncoded("templates.scan", "getAllTemplates", ["libraryPath"], "decodeBridge+json-array", ["array"], "js/templates/templates.js:loadTemplates");
    addEncoded("templates.favorite", "toggleFavTemplate", ["name", "category", "sourceRoot"], "ignored", ["callback"], "js/templates/templates.js:toggleFavorite");
    addEncoded("templates.delete", "deleteTemplate", ["name", "category", "sourceRoot"], "ignored", ["callback"], "js/templates/templates.js:deleteTemplate");
    addEncoded("templates.bulk-delete", "deleteTemplatesBulk", ["idsJoinedByDoublePipe", "categoriesJoinedByDoublePipe", "rootPath"], "decodeBridge+json-object", ["{ok:Number,failed:Array,error?:String}"], "js/templates/templates.js:performTmpBulkDelete");
    addEncoded("templates.rename", "renameTemplatePath", ["oldName", "newName", "category", "sourceRoot"], "ignored", ["callback"], "js/templates/templates.js:confirmRename");
    addEncoded("templates.move", "moveTemplatePath", ["name", "oldCategory", "newCategory", "sourceRoot"], "ignored", ["callback"], "js/templates/templates.js:confirmMove");
    add("templates.capabilities", "getSaveCapabilities", [], [], "decodeBridge+json-object", ["capability-object"], ERROR_SENTINELS, "js/templates/templates.js:openSaveModal");
    addEncoded("templates.validate-save", "validateSaveRequest", ["saveType"], "decodeBridge", ["true", "validation-string"], "js/templates/templates.js:confirmSave");
    // The reply is an explicit envelope, not a boolean: the host used to answer
    // with the matched folder's NAME while confirmSave compared it against the
    // literal "true". The fourth argument is the section actually being saved —
    // without it the host defaulted to "comp" and checked the wrong section.
    addEncoded("templates.item-exists", "itemExists", ["name", "category", "rootPath", "section"],
        "decodeBridge+json-object", ["{exists:Boolean,id?:String,section:String}"],
        "js/templates/templates.js:confirmSave", ERROR_SENTINELS, {
        transportPolicy: "guarded-callHost", timeoutPolicy: GUARDED_TIMEOUT,
        callbackBehavior: "promise-never-rejects-first-settlement-wins"
    });
    addEncoded("templates.batch-import", "importBatch", ["jsonPayload"], "import-engine-callback", ["batch-result"], "js/templates/templates.js:importTemplates");

    [
        ["comp", "saveActiveComp"], ["layer", "saveActiveLayer"], ["text", "saveActiveText"],
        ["text-properties", "saveActiveTextProperties"], ["footage", "saveActiveFootage"], ["effect", "saveActiveEffect"]
    ].forEach(function (item) {
        add("templates.save." + item[0], item[1], ["name", "category", "rootPath", "oldId"],
            ["hex-utf16", "hex-utf16", "hex-utf16", "hex-utf16"], "decodeBridge+feature-parser",
            ["feature-save-payload"], ERROR_SENTINELS.concat(["timeout"]), "js/templates/templates.js:confirmSave", {
            transportPolicy: "guarded-callHost", timeoutPolicy: GUARDED_TIMEOUT, callbackBehavior: "promise-never-rejects-first-settlement-wins"
        });
    });
    add("templates.save.png", "savePNGOnly", ["name", "category", "rootPath", "imageSection", "oldId"],
        ["hex-utf16", "hex-utf16", "hex-utf16", "hex-utf16", "hex-utf16"], "decodeBridge+feature-parser",
        ["monolithic-true"], ERROR_SENTINELS.concat(["timeout"]), "js/templates/templates.js:confirmSave", {
        transportPolicy: "guarded-callHost", timeoutPolicy: GUARDED_TIMEOUT, callbackBehavior: "promise-never-rejects-first-settlement-wins"
    });
    // Every Toolkit action below is dispatched by ToolBridge.call (bounded).
    var TOOL_BRIDGE_OPTIONS = {
        timeoutPolicy: TOOL_BRIDGE_TIMEOUT,
        callbackBehavior: "single-finalizer-late-suppressed"
    };
    var toolkitEncoded = [
        ["anchor", "toolkitAnchorPoint", "mode"], ["align", "toolkitAlignLayers", "mode"],
        ["create-layer", "toolkitCreateLayer", "mode"], ["multi-precomp", "toolkitMultiPrecomp", "mode"],
        ["sequence", "toolkitSequenceLayers", "modeParams"], ["resize-tree", "toolkitResizeCompTree", "mode"],
        ["bounce", "toolkitApplyBounce", "params"]
    ];
    toolkitEncoded.forEach(function (item) {
        addEncoded("toolkit." + item[0], item[1], [item[2]], "decodeBridge", ["true", "OK:*", "validation-string"], "js/toolkit/toolkit.js:runToolkitAction", null, TOOL_BRIDGE_OPTIONS);
    });
    [
        ["create-parent-null", "toolkitCreateParentNull"], ["organize", "toolkitOrganizeProject"],
        ["toggle-effects", "toolkitToggleEffects"], ["precompose", "toolkitPrecompose"],
        ["unprecompose", "toolkitUnprecompose"], ["clear-cache", "toolkitClearCache"],
        ["true-duplicate", "toolkitTrueDuplicate"], ["decompose", "toolkitDeCompose"],
        ["add-guides", "toolkitAddGuides"], ["clear-guides", "toolkitClearGuides"],
        ["remove-expressions", "toolkitRemoveExpressions"]
    ].forEach(function (item) {
        add("toolkit." + item[0], item[1], [], [], "decodeBridge", ["true", "OK:*", "validation-string"], ERROR_SENTINELS, "js/toolkit/toolkit.js:runToolkitAction", TOOL_BRIDGE_OPTIONS);
    });
    add("toolkit.check-shared-precomps", "toolkitCheckSharedPrecomps", [], [], "decodeBridge+json-object", ["{ok,sharedCount}"], ERROR_SENTINELS, "js/toolkit/toolkit.js:initCropPrecomp", TOOL_BRIDGE_OPTIONS);
    add("toolkit.crop-precomp", "toolkitCropPrecomp", ["duplicateShared"], ["raw-boolean"], "decodeBridge+json-object", ["{ok,croppedCount,warnings}"], ERROR_SENTINELS, "js/toolkit/toolkit.js:initCropPrecomp", {
        timeoutPolicy: toolBridgeTimeout(120000), callbackBehavior: "single-finalizer-late-suppressed"
    });
    add("easing.apply", "toolkitApplyFlow", ["incomingInfluence", "outgoingInfluence"], ["raw-number", "raw-number"], "decodeBridge", ["true", "validation-string"], ERROR_SENTINELS, "js/toolkit/flow.js:applyEasing", TOOL_BRIDGE_OPTIONS);
    addEncoded("colorflow.apply", "toolkitApplyColor", ["colorHex", "target"], "decodeBridge", ["true", "OK:*", "validation-string"], "js/toolkit/colorflow.js:applyColor", null, TOOL_BRIDGE_OPTIONS);
    addEncoded("paste.import-path", "toolkitImportPastedImage", ["normalizedPath"], "decodeBridge", ["OK:*", "validation-string"], "js/ui/paste.js:importPastedImage", null, {
        timeoutPolicy: toolBridgeTimeout(60000), callbackBehavior: "single-finalizer-late-suppressed"
    });
    add("paste.import-clipboard", "toolkitImportClipboardImage", [], [], "decodeBridge", ["OK:*", "validation-string"], ERROR_SENTINELS, "js/ui/paste.js:handleImagePaste", {
        timeoutPolicy: toolBridgeTimeout(120000), callbackBehavior: "single-finalizer-late-suppressed"
    });
    add("effects.validate-selection", null, [], [], "raw-status", ["ok"], ["no_comp", "no_layer", "no_effect"].concat(ERROR_SENTINELS), "js/toolkit/effects.js:handleEffectSave", { inlineExpressionId: "effects.selection-validation-v1", timeoutPolicy: TOOL_BRIDGE_TIMEOUT, callbackBehavior: "single-finalizer-late-suppressed" });
    add("effects.detect-name", null, [], [], "raw-string", ["effect-or-layer-name"], ["", "null", "EvalScript error.", "undefined"], "js/toolkit/effects.js:proceedWithSave", { inlineExpressionId: "effects.detect-selected-name-v1" });
    add("effects.save", null, ["customName", "targetDir"], ["escaped-raw-js-string", "hex-utf16"], "decodeBridge+json-object", ["{ok,file?,error?}"], ERROR_SENTINELS, "js/toolkit/effects.js:confirmPresetSave", { inlineExpressionId: "effects.rename-save-restore-v1", timeoutPolicy: TOOL_BRIDGE_TIMEOUT, callbackBehavior: "single-finalizer-late-suppressed" });
    addEncoded("effects.apply-ffx", "toolkitApplyEffectPreset", ["path"], "decodeBridge+json-object", ["{ok,error?}"], "js/toolkit/effects.js:handleEffectApply", null, TOOL_BRIDGE_OPTIONS);
    addEncoded("effects.apply-custom", "toolkitApplyCustomEffect", ["path"], "decodeBridge+json-object", ["{ok,error?}"], "js/toolkit/effects.js:handleEffectApply", null, TOOL_BRIDGE_OPTIONS);
    add("effects.pick-import-files", null, [], [], "raw-pipe-paths", ["path|path"], ["", "CANCEL", "EvalScript error.", "undefined"], "js/toolkit/effects.js:handleBulkImport", { inlineExpressionId: "effects.open-dialog-multi-v1" });

    addEncoded("text.ensure-dir", "taEnsureTextDir", ["directory"], "ignored", ["callback"], "js/textanim/textanim.js:resolveDir");
    add("text.default-root", null, [], [], "decodeBridge", ["path"], ERROR_SENTINELS, "js/textanim/textanim.js:resolveDir", { inlineExpressionId: "encodeBridge-getDefaultRootPath-v1" });
    add("text.reset", "taResetSelectedTextLayers", [], [], "decodeBridge+json-object", ["{ok,error?}"], ERROR_SENTINELS, "js/textanim/textanim.js:resetTextLayers");
    addEncoded("text.apply", "taApplyTextPreset", ["path"], "decodeBridge+json-object", ["{ok,created?,error?}"], "js/textanim/textanim.js:applyPreset");
    add("text.detect-name", "taDetectAnimationName", [], [], "decodeBridge+json-object", ["{name?}"], ERROR_SENTINELS, "js/textanim/textanim.js:openSaveModal");
    add("text.validate-selection", "taValidateTextSelection", [], [], "decodeBridge+json-object", ["{ok,error?}"], ERROR_SENTINELS, "js/textanim/textanim.js:confirmSave");
    addEncoded("text.save-direct", "taSavePresetDirectly", ["destinationPath"], "decodeBridge+json-object", ["{ok,path?,error?}"], "js/textanim/textanim.js:confirmSave");
    add("text.resolve-user-presets", "taResolveUserPresetsDir", [], [], "decodeBridge+json-object", ["{ok,paths?,debug?,error?}"], ERROR_SENTINELS, "js/textanim/textanim.js:confirmSave");
    addEncoded("text.invoke-save-dialog", "taInvokeSavePresetDialog", ["watchDir"], "decodeBridge+json-object", ["{ok,dialogShown?,error?}"], "js/textanim/textanim.js:confirmSave");
    addEncoded("text.relocate-preset", "taRelocatePreset", ["src", "destDir", "suggestedName"], "decodeBridge+json-object", ["{ok,file?,path?,error?}"], "js/textanim/textanim.js:confirmSave");
    addEncoded("text.delete-preset", "taDeleteTextPreset", ["path"], "decodeBridge+json-object", ["{ok,deletedCount?,error?}"], "js/textanim/textanim.js:purgePresetFiles");
    add("text.pick-import-files", null, [], [], "decodeBridge+pipe-paths", ["path|path", ""], ERROR_SENTINELS, "js/textanim/textanim.js:importFiles", { inlineExpressionId: "encodeBridge-taPickFfxFiles-v1" });
    addEncoded("text.render-thumbnail", "renderTemplateThumbnail", ["aepPath", "outputPngPath"], "decodeBridge+json-object", ["{ok,error?}"], "js/textanim/textanim.js:runOneThumbnail");
    contracts[contracts.length - 1].timeoutPolicy = PREVIEW_TIMEOUT;
    addEncoded("text.render-preview", "taRenderPresetPreview", ["presetPath", "tempDir", "label"], "decodeBridge+json-object", ["{ok,frames?,error?}"], "js/textanim/textanim.js:runOnePreview");
    contracts[contracts.length - 1].timeoutPolicy = PREVIEW_TIMEOUT;
    add("settings.pick-folder", null, [], [], "decodeBridge", ["path", ""], ERROR_SENTINELS, "js/ui/settings-panel.js:bind", { inlineExpressionId: "settings-folder-select-v1" });
    add("settings.pick-import", null, [], [], "decodeBridge", ["json-text", ""], ERROR_SENTINELS, "js/ui/settings-panel.js:bind", { inlineExpressionId: "settings-json-open-read-v1" });
    add("global.select-folder", "selectFolder", [], [], "decodeBridge", ["path", ""], ERROR_SENTINELS, "js/ui/settings-panel.js:bind");
    addEncoded("global.ensure-folder", "ensureFolder", ["path"], "ignored", ["callback"], "js/ui/settings-panel.js:bind");
    add("global.comp-monitor", null, [], [], "decodeBridge-applied-to-raw-baseline", ["active-item-name", ""], ERROR_SENTINELS, "js/ui/comp-monitor.js:updateActiveCompMonitor", { inlineExpressionId: "active-comp-name-raw-v1" });
    add("global.media-picker", null, ["mediaType"], ["raw-expression-branch"], "raw-path", ["path", ""], ERROR_SENTINELS, "js/core/fastMediaEngine.js:openMediaPicker", { inlineExpressionId: "media-open-dialog-v1" });
    add("global.ping", "compSaverPing", [], [], "raw-string", ["pong-or-status"], ERROR_SENTINELS, "js/main.js:init");
    add("global.debug-eval-file", null, ["jsxPath"], ["escaped-raw-js-string"], "raw-string", ["host-load-result"], ERROR_SENTINELS, "js/main.js:init", { inlineExpressionId: "debug-dollar-evalFile-v1" });

    function validate(list) {
        var errors = [];
        var ids = {};
        (list || []).forEach(function (item, index) {
            var prefix = "bridge[" + index + "]";
            if (!item || !item.id) errors.push(prefix + ":missing-id");
            else if (ids[item.id]) errors.push(prefix + ":duplicate-id:" + item.id);
            else ids[item.id] = true;
            if (!item.hostFunction && !item.inlineExpressionId) errors.push(prefix + ":missing-host-identity");
            if (!Array.isArray(item.argumentOrder) || !Array.isArray(item.argumentRepresentations) || item.argumentOrder.length !== item.argumentRepresentations.length) errors.push(prefix + ":argument-schema-mismatch");
            ["decoder", "transportPolicy", "callbackBehavior", "source"].forEach(function (key) { if (!item[key]) errors.push(prefix + ":missing-" + key); });
            if (!item.timeoutPolicy || !item.timeoutPolicy.policy) errors.push(prefix + ":missing-timeout-policy");
            else if (item.timeoutPolicy.policy === "tool-bridge") {
                // A tool-bridge contract claims ToolBridge's guarantees: a finite
                // bound, a never-rejecting result path, and late-callback
                // suppression. Reject a policy that only borrows the name.
                var tb = item.timeoutPolicy;
                if (typeof tb.milliseconds !== "number" || !isFinite(tb.milliseconds) || tb.milliseconds <= 0 ||
                    tb.nonRejecting !== true || tb.lateResponseSuppression !== true) {
                    errors.push(prefix + ":tool-bridge-policy-mismatch:" + item.id);
                }
            }
            if (!Array.isArray(item.successShapes) || !Array.isArray(item.failureSentinels)) errors.push(prefix + ":missing-result-contract");
        });
        return { ok: errors.length === 0, errors: errors };
    }

    function byId(id) {
        for (var i = 0; i < contracts.length; i++) if (contracts[i].id === id) return contracts[i];
        return null;
    }

    var api = { schemaVersion: "1.0.0", contracts: contracts, byId: byId, validate: validate, errorSentinels: ERROR_SENTINELS.slice(0) };
    if (typeof Object.freeze === "function") { Object.freeze(contracts); Object.freeze(api); }
    root.CompSaverBridgeRegistry = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof window !== "undefined" ? window : this));
