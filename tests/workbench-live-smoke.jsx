function csRunWorkbenchSmoke(extensionRoot) {
    var originalComp = app.project.activeItem;
    var originalIds = {};
    var originalCount = app.project.numItems;
    var owned = [];
    var sources = [];
    var results = [];
    var itemIndex;
    for (itemIndex = 1; itemIndex <= originalCount; itemIndex++) originalIds[app.project.item(itemIndex).id] = true;

    function check(condition, message) {
        if (!condition) throw new Error(message);
    }
    function success(payload) {
        var result = decodeBridge(payload);
        check(result.indexOf("OK:") === 0, result);
        return result;
    }
    function comp(name) {
        var created = app.project.items.addComp("CompSaver Smoke - " + name, 1080, 1920, 1, 4, 30);
        owned.push(created);
        created.openInViewer();
        return created;
    }
    function selectOnly(composition, layer) {
        for (var layerIndex = 1; layerIndex <= composition.numLayers; layerIndex++) composition.layer(layerIndex).selected = false;
        layer.selected = true;
    }
    function run(name, operation) {
        try { operation(comp(name)); results.push({ name: name, passed: true }); }
        catch (error) { results.push({ name: name, passed: false, error: error.toString() }); }
    }

    app.beginUndoGroup("CompSaver Temporary Smoke Tests");
    try {
        run("keyed mirror and blend", function (composition) {
            var layer = composition.layers.addShape();
            var scale = layer.property("ADBE Transform Group").property("ADBE Scale");
            scale.setValueAtTime(0, [100, 80]);
            scale.setValueAtTime(1, [120, 90]);
            selectOnly(composition, layer);
            success(toolkitMirrorLayers(encodeBridge("h")));
            check(scale.keyValue(1)[0] === -100 && scale.keyValue(2)[0] === -120, "Scale keys were not mirrored");
            success(toolkitBatchBlendMode(encodeBridge("SCREEN")));
            check(layer.blendingMode === BlendingMode.SCREEN, "Blend mode not applied");
        });
        run("split at playhead", function (composition) {
            var layer = composition.layers.addShape();
            selectOnly(composition, layer);
            composition.time = 1;
            success(toolkitSplitAtPlayhead());
            check(composition.numLayers === 2 && layer.outPoint === 1, "Split did not preserve left boundary");
            check(composition.layer(1).inPoint === 1, "Split did not set right boundary");
        });
        run("aspect ratio", function (composition) {
            success(toolkitSetAspectRatio(encodeBridge("1:1")));
            check(composition.width === 1080 && composition.height === 1080, "Incorrect square dimensions");
        });
        run("responsive text background", function (composition) {
            var text = composition.layers.addText("Smoke test");
            selectOnly(composition, text);
            success(toolkitCreateResponsiveTextBox());
            var plate = composition.layer(text.index + 1);
            var size = plate.property("ADBE Root Vectors Group").property(1).property("ADBE Vector Rect Size");
            var before = size.valueAtTime(0, false);
            check(!size.expressionError && before[0] > 60 && plate.parent === text, "Background expression or parenting failed");
            var sourceText = text.property("ADBE Text Properties").property("ADBE Text Document");
            var documentValue = sourceText.value;
            documentValue.text = "Smoke test with considerably longer text";
            sourceText.setValue(documentValue);
            check(size.valueAtTime(0, false)[0] > before[0], "Background did not resize with text");
        });
        run("text word splitter", function (composition) {
            var text = composition.layers.addText("One two");
            selectOnly(composition, text);
            success(toolkitSplitText(encodeBridge(jsonStringify({ mode: "words", stagger: 1 }))));
            check(composition.numLayers === 4 && !text.enabled, "Missing pieces, master or original backup");
            var pieces = 0;
            for (var layerIndex = 1; layerIndex <= composition.numLayers; layerIndex++) {
                var layer = composition.layer(layerIndex);
                if (!(layer instanceof TextLayer) || layer === text) continue;
                pieces++;
                check(!!layer.parent, "Text piece has no master");
                var animator = layer.property("ADBE Text Properties").property("ADBE Text Animators").property(1);
                check(animator.property("ADBE Text Selectors").numProperties > 0, "Missing isolation selector");
            }
            check(pieces === 2, "Incorrect word count");
        });
        run("literal text replacement", function (composition) {
            var text = composition.layers.addText("Price $5 and $5");
            selectOnly(composition, text);
            success(toolkitFindReplaceText(encodeBridge(jsonStringify({ find: "$5", replace: "$10", scope: "selection", matchCase: true }))));
            check(text.property("ADBE Text Properties").property("ADBE Text Document").value.text === "Price $10 and $10", "Literal replacement changed dollar signs");
        });
        run("reverse and speed ramp", function (composition) {
            var source = comp("timing source");
            composition.openInViewer();
            var layer = composition.layers.add(source);
            selectOnly(composition, layer);
            success(toolkitReverseVideo());
            var remap = layer.property("ADBE Time Remapping");
            check(remap.numKeys === 2 && remap.keyValue(1) > remap.keyValue(2), "Reverse remap is not descending");
            layer.timeRemapEnabled = false;
            composition.time = 1;
            success(toolkitApplySpeedRamp(encodeBridge("smooth")));
            check(layer.timeRemapEnabled && layer.property("ADBE Time Remapping").numKeys >= 4, "Missing ramp keys");
            success(toolkitCompactTimeRemap());
        });
        run("One-Framer apply and rollback", function (composition) {
            var layer = composition.layers.addShape();
            selectOnly(composition, layer);
            var recipe = { name: "Smoke Slider", effects: [{ mn: "ADBE Slider Control", p: [[1, 42]] }] };
            success(toolkitApplyOneFramer(encodeBridge(jsonStringify(recipe))));
            var effects = layer.property("ADBE Effect Parade");
            check(effects.numProperties === 1 && effects.property(1).property(1).value === 42, "Recipe value not applied");
            recipe.effects[0].p = [[999, 42]];
            check(decodeBridge(toolkitApplyOneFramer(encodeBridge(jsonStringify(recipe)))).indexOf("PRE:") === 0, "Invalid recipe did not fail");
            check(effects.numProperties === 1, "Failed recipe left an effect behind");
        });
        run("Instagram guide toggle", function (composition) {
            var guidePath = extensionRoot + "/assets/guides/ig_reel_guide_1080x1920.png";
            success(toolkitToggleIGReelGuide(encodeBridge(guidePath)));
            var guide = composition.layer(1);
            check(guide.locked && guide.guideLayer && guide.enabled, "Guide flags incorrect");
            success(toolkitToggleIGReelGuide(encodeBridge(guidePath)));
            check(composition.numLayers === 1 && !guide.enabled && guide.locked, "Guide toggle duplicated or unlocked the layer");
        });
    } finally {
        try {
            for (var compIndex = 0; compIndex < owned.length; compIndex++) {
                for (var layerIndex = 1; layerIndex <= owned[compIndex].numLayers; layerIndex++) {
                    var sourceItem = owned[compIndex].layer(layerIndex).source;
                    if (sourceItem instanceof FootageItem && !originalIds[sourceItem.id]) sources.push(sourceItem);
                }
            }
            for (var removeIndex = owned.length - 1; removeIndex >= 0; removeIndex--) owned[removeIndex].remove();
            for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
                if (isValid(sources[sourceIndex]) && sources[sourceIndex].usedIn.length === 0) sources[sourceIndex].remove();
            }
            if (originalComp instanceof CompItem) originalComp.openInViewer();
            check(app.project.numItems === originalCount, "Temporary project items remain");
            results.push({ name: "temporary item cleanup", passed: true });
        } catch (cleanupError) {
            results.push({ name: "temporary item cleanup", passed: false, error: cleanupError.toString() });
        } finally { app.endUndoGroup(); }
    }
    return jsonStringify({ version: app.version, results: results });
}