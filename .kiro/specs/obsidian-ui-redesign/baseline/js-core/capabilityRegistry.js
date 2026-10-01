/* Executable inventory of the pre-redesign capability baseline. */
(function (root) {
    "use strict";
    var capabilities = [];

    function add(id, moduleId, kind, handler, selector, eventName, bridgeIds, requirements, notes) {
        capabilities.push({
            id: id,
            module: moduleId,
            kind: kind,
            browserHandler: handler,
            legacyBinding: { selector: selector, event: eventName },
            bridgeIds: bridgeIds ? bridgeIds.slice(0) : [],
            requirementIds: requirements ? requirements.slice(0) : [],
            notes: notes || ""
        });
    }
    function family(moduleId, prefix, kind, handler, selectorPrefix, eventName, names, bridgePrefix, requirements) {
        names.forEach(function (name) {
            add(prefix + "." + name, moduleId, kind, handler, selectorPrefix + name + "]", eventName,
                bridgePrefix ? [bridgePrefix + name] : [], requirements);
        });
    }

    ["templates", "tools", "effects", "text", "easing", "colorflow", "settings"].forEach(function (route) {
        add("navigation." + route, "shell", "navigation", "switchMainModule", '[data-module="' + route + '"]', "click", [], ["2.1", "2.4"]);
    });
    add("shortcut.global.escape", "shell", "shortcut", "document keydown modal closer", "document", "keydown:Escape", [], ["2.3"], "Closes all open baseline modal/overflow surfaces.");
    add("shortcut.templates.search", "templates", "shortcut", "document keydown template search", "document", "keydown:CtrlOrMeta+F", [], ["2.3"]);
    add("shortcut.templates.save", "templates", "shortcut", "document keydown openSaveModal", "document", "keydown:CtrlOrMeta+S", [], ["2.3"]);
    add("shortcut.modal.confirm-save", "templates", "shortcut", "input-name keydown confirmSave", "#input-name", "keydown:Enter", [], ["2.3"]);
    add("shortcut.modal.confirm-rename", "templates", "shortcut", "rename-input keydown confirmRename", "#rename-input", "keydown:Enter", [], ["2.3"]);
    family("templates", "templates.save", "primary-action", "confirmSave", '[data-save-type="', "click", ["comp", "layer", "text", "text-properties", "footage", "effect", "png"], "templates.save.", ["2.1", "2.2", "3.1"]);
    [
        ["scan", "loadTemplates", "#btn-refresh-templates", "click", ["templates.scan"]],
        ["import", "importTemplates", ".card", "click/import", ["templates.batch-import"]],
        ["apply", "importTemplates", ".card", "click/apply", ["templates.batch-import"]],
        ["favorite", "toggleFavorite", ".fav-btn", "click", ["templates.favorite"]],
        ["delete", "deleteTemplate", ".delete-btn", "click", ["templates.delete"]],
        ["bulk-delete", "performTmpBulkDelete", "#btn-tmp-bulk-confirm", "click", ["templates.bulk-delete"]],
        ["rename", "confirmRename", "#rename-confirm", "click", ["templates.rename"]],
        ["move", "confirmMove", "#move-confirm", "click", ["templates.move"]],
        ["search", "filterTemplates", "#search-templates", "input", []],
        ["filter-type", "switchSection", "[data-section]", "click", []],
        ["filter-favorites", "setCategory", "[data-category=Favorites]", "click", []],
        ["category-create", "createCategory", "#btn-create-category", "click", []],
        ["category-rename", "renameCategory", "#btn-rename-category", "click", []],
        ["category-move", "confirmMove", "#move-cat-select", "change", ["templates.move"]],
        ["category-delete", "deleteCategory", "#btn-delete-category", "click", []],
        ["browse-folder", "SettingsPanel library browse", "#btn-browse-library", "click", ["global.select-folder", "global.ensure-folder"]],
        ["card-size", "setCardSize", "[data-card-size]", "click", []],
        ["density", "setDensity", "[data-density]", "click", []],
        ["bulk-cancel", "setTmpBulkMode", "#btn-tmp-bulk-toggle", "click", []]
    ].forEach(function (row) { add("templates." + row[0], "templates", "action", row[1], row[2], row[3], row[4], ["2.1", "2.2", "2.4"]); });
    var toolkitRows = [
        ["anchor", "toolkit.anchor", "anchor"], ["align", "toolkit.align", "align"], ["create-layer", "toolkit.create-layer", "create"],
        ["create-parent-null", "toolkit.create-parent-null", "create"], ["organize", "toolkit.organize", "organize"],
        ["toggle-effects", "toolkit.toggle-effects", "effects"], ["precompose", "toolkit.precompose", "precompose"],
        ["unprecompose", "toolkit.unprecompose", "unprecompose"], ["clear-cache", "toolkit.clear-cache", "cache"],
        ["multi-precomp", "toolkit.multi-precomp", "multiprecomp"], ["sequence", "toolkit.sequence", "sequence"],
        ["true-duplicate", "toolkit.true-duplicate", "truedup"], ["decompose", "toolkit.decompose", "decompose"],
        ["resize-tree", "toolkit.resize-tree", "resize"], ["bounce", "toolkit.bounce", "bounce"],
        ["add-guides", "toolkit.add-guides", "guides-on"], ["clear-guides", "toolkit.clear-guides", "guides-off"],
        ["remove-expressions", "toolkit.remove-expressions", "delete-expression"], ["paste", "paste.import-clipboard", "paste"]
    ];
    toolkitRows.forEach(function (row) {
        add("toolkit." + row[0], "tools", "host-action", "runToolkitAction", '[data-toolkit-action="' + row[2] + '"]', "click", [row[1]], ["2.1", "2.2", "3.1"]);
    });
    add("toolkit.crop-precomp", "tools", "host-action", "initCropPrecomp", "#btn-crop-precomp", "click", ["toolkit.check-shared-precomps", "toolkit.crop-precomp"], ["2.2", "3.1"]);
    add("shortcut.toolkit.delete-effect", "effects", "shortcut", "document keydown selected effect delete", "document", "keydown:DeleteOrBackspace", [], ["2.3"]);
    add("shortcut.toolkit.sequence-step", "tools", "shortcut", "sequencer stepper keydown", "#seq-stepper", "keydown:ArrowUpOrDown(+Shift10)", [], ["2.3"]);
    add("modifier.toolkit.create-null", "tools", "modified-action", "runToolkitAction", '[data-toolkit-action="create"][data-mode="null"]', "click:Shift", ["toolkit.create-layer"], ["2.3"]);
    add("context.effects.inline-rename", "effects", "context-action", "startInlineRename", ".tk-effect-card", "contextmenu", [], ["2.3", "2.4"]);
    [
        ["save", "confirmPresetSave", "#btn-tk-save-preset-confirm", ["effects.validate-selection", "effects.detect-name", "effects.save"]],
        ["apply", "handleEffectApply", ".tk-effect-card .apply-btn", ["effects.apply-ffx", "effects.apply-custom"]],
        ["import", "handleBulkImport", "#btn-tk-import-effects", ["effects.pick-import-files"]],
        ["favorite", "handleEffectFavorite", ".tk-effect-card .favorite-btn", []],
        ["rename", "handleEffectRename", ".tk-effect-card .rename-btn", []],
        ["delete", "handleEffectDelete", ".tk-effect-card .delete-btn", []],
        ["bulk-delete", "performEffectBulkDelete", "#btn-tk-effect-bulk-confirm", []],
        ["search", "filterEffects", "#tk-effect-search", []],
        ["category-create", "createEffectCategory", "#btn-tk-effect-category-add", []],
        ["category-rename", "renameEffectCategory", "#btn-tk-effect-category-rename", []],
        ["category-delete", "deleteEffectCategory", "#btn-tk-effect-category-delete", []],
        ["refresh", "loadSavedEffects", "#btn-tk-effect-refresh", ["global.ensure-folder"]]
    ].forEach(function (row) { add("effects." + row[0], "effects", "action", row[1], row[2], "click", row[3], ["2.1", "2.2", "3.1"]); });

    [
        ["apply", "applyPreset", ".ta-card", "click", ["text.apply"]],
        ["save", "confirmSave", "#btn-ta-save-confirm", "click", ["text.validate-selection", "text.save-direct", "text.render-preview"]],
        ["reset", "resetTextLayers", "#btn-ta-reset", "click", ["text.reset"]],
        ["import", "importFiles", "#btn-ta-import", "click", ["text.pick-import-files"]],
        ["rename", "confirmRename", "#btn-ta-preset-rename-confirm", "click", []],
        ["delete", "deleteOne", ".ta-card .delete-btn", "click", []],
        ["favorite", "toggleTextFavorite", ".ta-card .favorite-btn", "click", []],
        ["refresh", "refreshFromDisk", "#btn-ta-refresh", "click", []],
        ["search", "renderGrid", "#ta-search", "input", []],
        ["category-create", "createCategory", "#btn-ta-category-add", "click", []],
        ["category-rename", "renameCategory", "#btn-ta-category-rename", "click", []],
        ["category-delete", "deleteCategory", "#btn-ta-category-delete", "click", []],
        ["bulk-delete", "performTextBulkDelete", "#btn-ta-bulk-confirm", "click", []]
    ].forEach(function (row) { add("text." + row[0], "text", "action", row[1], row[2], row[3], row[4], ["2.1", "2.2", "3.1"]); });
    add("context.text.rename", "text", "context-action", "openRenameModal", '.ta-context-item[data-act="rename"]', "contextmenu+click", [], ["2.3"]);
    add("context.text.delete", "text", "context-action", "deleteOne", '.ta-context-item[data-act="delete"]', "contextmenu+click", [], ["2.3"]);
    add("shortcut.text.save-enter", "text", "shortcut", "confirmSave", "#ta-name-input", "keydown:Enter", [], ["2.3"]);
    add("shortcut.text.rename-enter", "text", "shortcut", "confirmRename", "#ta-preset-rename-input", "keydown:Enter", [], ["2.3"]);
    add("modifier.text.refresh-previews", "text", "modified-action", "backfillPreviewsForCurrentView", "#btn-ta-refresh", "click:Shift", ["text.render-preview"], ["2.3"]);
    [
        ["apply", "applyEasing", "#btn-flow-apply", ["easing.apply"]],
        ["edit-curve", "FlowSystem drag handlers", "#flow-graph", []],
        ["numeric-incoming", "FlowSystem input handler", "#flow-incoming", []],
        ["numeric-outgoing", "FlowSystem input handler", "#flow-outgoing", []],
        ["preset-select", "FlowSystem selectPreset", ".flow-preset-card", []],
        ["preset-save", "FlowSystem savePreset", "#btn-flow-save", []],
        ["preset-import", "FlowSystem importPreset", "#btn-flow-import", []],
        ["preset-rename", "FlowSystem renamePreset", ".flow-preset-rename", []],
        ["preset-delete", "FlowSystem deletePreset", ".flow-preset-delete", []],
        ["preset-favorite", "FlowSystem toggleFavorite", ".flow-preset-favorite", []],
        ["reset", "resetToolkitDefaults", "#btn-flow-reset", []]
    ].forEach(function (row) { add("easing." + row[0], "easing", "action", row[1], row[2], "click-or-input", row[3], ["2.1", "2.2", "3.1"]); });

    [
        ["apply", "ColorFlow.applyColor", ".cf-swatch", ["colorflow.apply"]],
        ["palette-select", "ColorFlow.selectPalette", "#cf-palette-select", []],
        ["palette-create", "ColorFlow.createPalette", "#btn-cf-create", []],
        ["palette-rename", "ColorFlow.renamePalette", "#btn-cf-rename", []],
        ["palette-delete", "ColorFlow.deletePalette", "#btn-cf-delete", []],
        ["swatch-edit", "ColorFlow.openWorkshop", ".cf-swatch-edit", []],
        ["target-fill", "ColorFlow target handler", '[data-target="fill"]', []],
        ["target-stroke", "ColorFlow target handler", '[data-target="stroke"]', []],
        ["target-both", "ColorFlow target handler", '[data-target="both"]', []]
    ].forEach(function (row) { add("colorflow." + row[0], "colorflow", "action", row[1], row[2], "click", row[3], ["2.1", "2.2", "3.1"]); });
    add("modifier.colorflow.stroke", "colorflow", "modified-action", "ColorFlow swatch/editor handlers", ".cf-swatch,#cf-editor-hex", "click-or-keydown:Shift", ["colorflow.apply"], ["2.3"]);
    add("shortcut.colorflow.commit-hex", "colorflow", "shortcut", "ColorFlow editorHexInput keydown", "#cf-editor-hex", "keydown:Enter", ["colorflow.apply"], ["2.3"]);
    [
        ["search", "SettingsPanel search handler", "#settings-search", "input", []],
        ["set-value", "Settings.set", "[data-setting-key]", "change", []],
        ["group-reset", "Settings.resetGroup", "[data-reset-group]", "click", []],
        ["reset-all", "Settings.reset", "#btn-settings-reset-all", "click", []],
        ["export", "Settings.export", "#btn-settings-export", "click", []],
        ["import", "Settings.import", "#btn-settings-import", "click", ["settings.pick-import"]],
        ["backup", "SettingsPanel backup handler", "#btn-settings-backup", "click", []],
        ["browse-library", "SettingsPanel browse handler", "#btn-browse-library", "click", ["global.select-folder", "global.ensure-folder"]],
        ["browse-folder-field", "SettingsPanel folder field handler", "[data-browse-folder]", "click", ["settings.pick-folder"]]
    ].forEach(function (row) { add("settings." + row[0], "settings", "action", row[1], row[2], row[3], row[4], ["2.1", "2.2", "2.4"]); });
    add("global.comp-monitor", "shell", "status", "updateActiveCompMonitor", "#monitor-active-comp", "poll", ["global.comp-monitor"], ["2.2", "3.1"]);
    add("global.media-picker", "templates", "action", "FastMediaEngine.openMediaPicker", "media-picker-request", "programmatic", ["global.media-picker"], ["2.2", "3.1"]);
    add("global.paste-path", "tools", "action", "importPastedImage", "clipboard-file", "paste", ["paste.import-path"], ["2.2", "3.1"]);
    add("accessibility.modal-tab-wrap", "shell", "shortcut", "FocusTrap.handleKeyDown", "document", "keydown:TabOrShiftTab", [], ["2.3", "2.4"]);
    add("accessibility.dismiss-accent", "settings", "shortcut", "AccentPicker escHandler", "document", "keydown:Escape", [], ["2.3", "2.4"]);

    function byId(id) {
        for (var i = 0; i < capabilities.length; i++) if (capabilities[i].id === id) return capabilities[i];
        return null;
    }
    function validate(list, bridgeRegistry) {
        var errors = [], ids = {};
        (list || []).forEach(function (item, index) {
            var p = "capability[" + index + "]";
            if (!item.id) errors.push(p + ":missing-id");
            else if (ids[item.id]) errors.push(p + ":duplicate-id:" + item.id);
            else ids[item.id] = true;
            ["module", "kind", "browserHandler"].forEach(function (key) { if (!item[key]) errors.push(p + ":missing-" + key); });
            if (!item.legacyBinding || !item.legacyBinding.selector || !item.legacyBinding.event) errors.push(p + ":missing-legacy-binding");
            if (!Array.isArray(item.bridgeIds) || !Array.isArray(item.requirementIds)) errors.push(p + ":invalid-links");
            if (bridgeRegistry) item.bridgeIds.forEach(function (bridgeId) { if (!bridgeRegistry.byId(bridgeId)) errors.push(p + ":unknown-bridge:" + bridgeId); });
        });
        return { ok: errors.length === 0, errors: errors };
    }
    var api = { schemaVersion: "1.0.0", capabilities: capabilities, byId: byId, validate: validate };
    if (typeof Object.freeze === "function") { Object.freeze(capabilities); Object.freeze(api); }
    root.CompSaverCapabilityRegistry = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof window !== "undefined" ? window : this));
