// CompSaver ExtendScript Host - Workbench module (obsidian-ui-redesign)
// ES3 only: var and function declarations, no const/let/arrow/template
// literals. Included from compSaver.jsx right after text.jsx, so
// encodeBridge, decodeBridge, jsonStringify and jsonParse from core.jsx
// are available. Declarations only: nothing runs at include time.

// Read-only Comp_Monitor query (Req 8.4, 8.5). No undo group: it changes
// nothing (Req 2.5 covers changes only). Returns one Bridge_Payload:
//   OK:{"comp":false}
//   OK:{"comp":true,"name":...,"width":...,"height":...,"fps":...}
//   Comp monitor error: <message>
function csActiveCompInfo() {
    try {
        var item = app.project ? app.project.activeItem : null;
        if (!(item instanceof CompItem)) return encodeBridge("OK:" + jsonStringify({ comp: false }));
        return encodeBridge("OK:" + jsonStringify({
            comp: true,
            name: item.name,
            width: item.width,
            height: item.height,
            fps: item.frameRate
        }));
    } catch (e) {
        return encodeBridge("Comp monitor error: " + e.toString());
    }
}

function csWorkbenchRun(label, needsSelection, operation) {
    var comp = app.project ? app.project.activeItem : null;
    if (!(comp instanceof CompItem)) return encodeBridge("PRE:no-comp:Open a composition first.");
    var selected = comp.selectedLayers;
    var layers = [];
    var layerIndex;
    for (layerIndex = 0; layerIndex < selected.length; layerIndex++) layers.push(selected[layerIndex]);
    if (needsSelection && layers.length === 0) return encodeBridge("PRE:no-selection:Select layers first.");
    app.beginUndoGroup(label);
    try {
        return encodeBridge(operation(comp, layers));
    } catch (error) {
        return encodeBridge(label + " failed: " + error.toString() + ". Undo to restore any partial changes.");
    } finally {
        app.endUndoGroup();
    }
}

function csWorkbenchEach(layers, label, operation) {
    var changed = 0;
    var skipped = 0;
    var reason = "";
    for (var layerIndex = 0; layerIndex < layers.length; layerIndex++) {
        var layer = layers[layerIndex];
        if (layer.locked) { skipped++; reason = "Locked layers"; continue; }
        var result = operation(layer);
        if (result === true) changed++;
        else { skipped++; reason = String(result || "Unsupported layers"); }
    }
    if (!changed) return "PRE:unsupported:" + (reason || "No compatible layers selected.");
    return "OK:" + label + ": " + changed + " layer(s)" + (skipped ? "; skipped " + skipped + " (" + reason + ")" : "");
}

function toolkitToggleIGReelGuide(pathHex) {
    return csWorkbenchRun("Instagram Reel Guide", false, function (comp) {
        var tag = "compsaver:ig-reel-guide:v1";
        for (var layerIndex = 1; layerIndex <= comp.numLayers; layerIndex++) {
            var existing = comp.layer(layerIndex);
            if (existing.comment !== tag) continue;
            existing.locked = false;
            try {
                existing.enabled = !existing.enabled;
                existing.guideLayer = true;
                existing.moveToBeginning();
            } finally {
                existing.locked = true;
            }
            return "OK:Instagram Reel Guide " + (existing.enabled ? "enabled" : "hidden") + " (locked, non-rendering)";
        }
        var asset = new File(decodeBridge(pathHex));
        if (!asset.exists) return "PRE:guide-asset:Instagram guide asset is missing. Reinstall the panel assets.";
        var footage = null;
        for (var itemIndex = 1; itemIndex <= app.project.numItems; itemIndex++) {
            var item = app.project.item(itemIndex);
            if (item instanceof FootageItem && item.file && item.file.fsName === asset.fsName) { footage = item; break; }
        }
        if (!footage) footage = app.project.importFile(new ImportOptions(asset));
        var guide = comp.layers.add(footage);
        guide.comment = tag;
        guide.name = "[GUIDE] Instagram Reel Safezone";
        guide.guideLayer = true;
        guide.inPoint = 0;
        guide.outPoint = comp.duration;
        guide.moveToBeginning();
        var transform = guide.property("ADBE Transform Group");
        transform.property("ADBE Anchor Point").setValue([footage.width / 2, footage.height / 2]);
        transform.property("ADBE Position").setValue([comp.width / 2, comp.height / 2]);
        transform.property("ADBE Scale").setValue([comp.width / footage.width * 100, comp.height / footage.height * 100]);
        guide.locked = true;
        return "OK:Instagram Reel Guide enabled (locked, non-rendering)";
    });
}

function toolkitMirrorLayers(axisHex) {
    var axis = decodeBridge(axisHex);
    if (axis !== "h" && axis !== "v") return encodeBridge("Invalid mirror axis.");
    return csWorkbenchRun("Mirror Layers", true, function (comp, layers) {
        return csWorkbenchEach(layers, "Mirrored", function (layer) {
            var transform = layer.property("ADBE Transform Group");
            var scale = transform ? transform.property("ADBE Scale") : null;
            if (!scale || scale.expressionEnabled) return "Scale unavailable or expression-driven";
            var component = axis === "h" ? 0 : 1;
            if (scale.numKeys > 0) {
                for (var keyIndex = 1; keyIndex <= scale.numKeys; keyIndex++) {
                    var keyed = scale.keyValue(keyIndex);
                    keyed[component] = -keyed[component];
                    scale.setValueAtKey(keyIndex, keyed);
                }
            } else {
                var value = scale.value;
                value[component] = -value[component];
                scale.setValue(value);
            }
            return true;
        });
    });
}

function csWorkbenchIsAVLayer(layer) {
    return layer instanceof AVLayer ||
        (typeof ShapeLayer !== "undefined" && layer instanceof ShapeLayer) ||
        (typeof TextLayer !== "undefined" && layer instanceof TextLayer);
}

function toolkitBatchBlendMode(modeHex) {
    var mode = decodeBridge(modeHex);
    var allowed = { NORMAL: true, MULTIPLY: true, SCREEN: true, ADD: true, OVERLAY: true, SOFT_LIGHT: true, DIFFERENCE: true };
    if (!allowed[mode]) return encodeBridge("Invalid blend mode.");
    return csWorkbenchRun("Batch Blend Mode", true, function (comp, layers) {
        return csWorkbenchEach(layers, "Blend mode applied", function (layer) {
            if (!csWorkbenchIsAVLayer(layer)) return "Cameras and lights have no blend mode";
            layer.blendingMode = BlendingMode[mode];
            return true;
        });
    });
}

function toolkitSplitAtPlayhead() {
    return csWorkbenchRun("Split at Playhead", true, function (comp, layers) {
        return csWorkbenchEach(layers, "Split", function (layer) {
            if (comp.time <= layer.inPoint || comp.time >= layer.outPoint) return "Layers must span the playhead";
            if (layer.hasTrackMatte || layer.isTrackMatte) return "Track-matte layers require manual splitting";
            var right = layer.duplicate();
            right.inPoint = comp.time;
            layer.outPoint = comp.time;
            return true;
        });
    });
}

function csWorkbenchRemap(layer) {
    if (!csWorkbenchIsAVLayer(layer) || !layer.hasVideo || (!layer.timeRemapEnabled && !layer.canSetTimeRemapEnabled)) return null;
    return layer.property("ADBE Time Remapping");
}

function csWorkbenchReplaceRemapKeys(remap, keys) {
    while (remap.numKeys > 1) remap.removeKey(remap.numKeys);
    var retainedTime = remap.keyTime(1);
    var retainOriginal = false;
    for (var keyIndex = 0; keyIndex < keys.length; keyIndex++) {
        var saved = keys[keyIndex];
        remap.setValueAtTime(saved.time, saved.value);
        if (Math.abs(saved.time - retainedTime) < 0.0000001) retainOriginal = true;
    }
    if (!retainOriginal) remap.removeKey(remap.nearestKeyIndex(retainedTime));
}

function toolkitReverseVideo() {
    return csWorkbenchRun("Reverse Video", true, function (comp, layers) {
        return csWorkbenchEach(layers, "Reversed", function (layer) {
            if (!csWorkbenchIsAVLayer(layer) || !layer.hasVideo || (!layer.timeRemapEnabled && !layer.canSetTimeRemapEnabled)) return "Time Remap unavailable";
            if (layer.timeRemapEnabled) return "Existing Time Remap preserved; disable it before reversing";
            var first = layer.inPoint;
            var last = layer.outPoint - comp.frameDuration;
            if (last <= first) return "Layer is shorter than two frames";
            layer.timeRemapEnabled = true;
            var remap = csWorkbenchRemap(layer);
            var firstValue = remap.valueAtTime(first, false);
            var lastValue = remap.valueAtTime(last, false);
            csWorkbenchReplaceRemapKeys(remap, [{ time: first, value: lastValue }, { time: last, value: firstValue }]);
            return true;
        });
    });
}

function toolkitApplySpeedRamp(presetHex) {
    var preset = decodeBridge(presetHex);
    if (!/^(smooth|fast|punch)$/.test(preset)) return encodeBridge("Invalid speed ramp preset.");
    return csWorkbenchRun("Instant Speed Ramp", true, function (comp, layers) {
        return csWorkbenchEach(layers, "Speed ramp applied", function (layer) {
            if (!csWorkbenchIsAVLayer(layer) || !layer.hasVideo || (!layer.timeRemapEnabled && !layer.canSetTimeRemapEnabled)) return "Time Remap unavailable";
            if (layer.timeRemapEnabled) return "Existing Time Remap preserved; disable it before adding a ramp";
            var first = Math.max(layer.inPoint, comp.time - 0.5);
            var last = Math.min(layer.outPoint - comp.frameDuration, comp.time + 0.8);
            if (comp.time < layer.inPoint || comp.time >= layer.outPoint || last - first < comp.frameDuration * 4) return "Place playhead inside a layer with at least five frames";
            layer.timeRemapEnabled = true;
            var remap = csWorkbenchRemap(layer);
            var startValue = remap.valueAtTime(first, false);
            var endValue = remap.valueAtTime(last, false);
            var span = last - first;
            var sourceSpan = endValue - startValue;
            var times = [first, first + span * 0.3, first + span * 0.65, last];
            var fractions = preset === "fast" ? [0, 0.65, 0.85, 1] : preset === "punch" ? [0, 0.7, 0.75, 1] : [0, 0.2, 0.8, 1];
            for (var keyIndex = 0; keyIndex < times.length; keyIndex++) {
                remap.setValueAtTime(times[keyIndex], startValue + sourceSpan * fractions[keyIndex]);
                var key = remap.nearestKeyIndex(times[keyIndex]);
                remap.setInterpolationTypeAtKey(key, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
                remap.setTemporalEaseAtKey(key, [new KeyframeEase(0, 85)], [new KeyframeEase(0, 85)]);
            }
            return true;
        });
    });
}

function toolkitCompactTimeRemap() {
    return csWorkbenchRun("Compact Time Remap", true, function (comp, layers) {
        return csWorkbenchEach(layers, "Compacted", function (layer) {
            if (!layer.timeRemapEnabled) return "Enable Time Remap first";
            var remap = csWorkbenchRemap(layer);
            if (!remap || remap.numKeys < 2 || remap.expressionEnabled) return "Requires two keys without an expression";
            var sourceFrame = layer.source && layer.source.frameDuration ? layer.source.frameDuration : comp.frameDuration;
            var keys = [];
            for (var keyIndex = 1; keyIndex <= remap.numKeys; keyIndex++) {
                var entry = {
                    time: Math.round(remap.keyTime(keyIndex) / comp.frameDuration) * comp.frameDuration,
                    value: Math.round(remap.keyValue(keyIndex) / sourceFrame) * sourceFrame,
                    incoming: remap.keyInInterpolationType(keyIndex), outgoing: remap.keyOutInterpolationType(keyIndex),
                    easeIn: remap.keyInTemporalEase(keyIndex), easeOut: remap.keyOutTemporalEase(keyIndex)
                };
                if (keys.length && Math.abs(keys[keys.length - 1].time - entry.time) < comp.frameDuration / 100) keys[keys.length - 1] = entry;
                else keys.push(entry);
            }
            if (keys.length < 2 || keys[keys.length - 1].time <= layer.inPoint) return "Keys collapse to fewer than two usable frames";
            csWorkbenchReplaceRemapKeys(remap, keys);
            for (var writeIndex = 0; writeIndex < keys.length; writeIndex++) {
                var saved = keys[writeIndex];
                remap.setInterpolationTypeAtKey(writeIndex + 1, saved.incoming, saved.outgoing);
                if (saved.incoming === KeyframeInterpolationType.BEZIER || saved.outgoing === KeyframeInterpolationType.BEZIER) {
                    remap.setTemporalEaseAtKey(writeIndex + 1, saved.easeIn, saved.easeOut);
                }
            }
            layer.outPoint = Math.min(layer.outPoint, keys[keys.length - 1].time + comp.frameDuration);
            return true;
        });
    });
}

function toolkitSetAspectRatio(ratioHex) {
    var ratio = decodeBridge(ratioHex);
    var sizes = { "9:16": [1080, 1920], "16:9": [1920, 1080], "1:1": [1080, 1080], "4:5": [1080, 1350] };
    if (!sizes[ratio]) return encodeBridge("Invalid aspect ratio.");
    return csWorkbenchRun("Switch Aspect Ratio", false, function (comp) {
        comp.width = sizes[ratio][0];
        comp.height = sizes[ratio][1];
        return "OK:Composition resized to " + comp.width + " x " + comp.height;
    });
}

function toolkitCreateResponsiveTextBox() {
    return csWorkbenchRun("Responsive Text Box", true, function (comp, layers) {
        return csWorkbenchEach(layers, "Text boxes created", function (textLayer) {
            if (!(textLayer instanceof TextLayer)) return "Select text layers";
            var plate = comp.layers.addShape();
            plate.name = textLayer.name + " - Background";
            plate.threeDLayer = textLayer.threeDLayer;
            plate.parent = textLayer;
            plate.inPoint = textLayer.inPoint;
            plate.outPoint = textLayer.outPoint;
            plate.moveAfter(textLayer);
            var transform = plate.property("ADBE Transform Group");
            transform.property("ADBE Anchor Point").setValue(plate.threeDLayer ? [0, 0, 0] : [0, 0]);
            transform.property("ADBE Position").setValue(plate.threeDLayer ? [0, 0, 0] : [0, 0]);
            transform.property("ADBE Scale").setValue(plate.threeDLayer ? [100, 100, 100] : [100, 100]);
            transform.property("ADBE Rotate Z").setValue(0);
            if (plate.threeDLayer) {
                transform.property("ADBE Orientation").setValue([0, 0, 0]);
                transform.property("ADBE Rotate X").setValue(0);
                transform.property("ADBE Rotate Y").setValue(0);
            }
            var effects = plate.property("ADBE Effect Parade");
            var controlNames = ["Padding X", "Padding Y", "Corner Radius"];
            var defaults = [30, 20, 12];
            for (var controlIndex = 0; controlIndex < controlNames.length; controlIndex++) {
                var slider = effects.addProperty("ADBE Slider Control");
                slider.name = controlNames[controlIndex];
                slider.property(1).setValue(defaults[controlIndex]);
            }
            var color = effects.addProperty("ADBE Color Control");
            color.name = "Fill Color";
            color.property(1).setValue([0.04, 0.05, 0.07, 1]);
            var contents = plate.property("ADBE Root Vectors Group");
            contents.addProperty("ADBE Vector Shape - Rect");
            contents.addProperty("ADBE Vector Graphic - Fill");
            var rectangle = contents.property(1);
            rectangle.property("ADBE Vector Rect Size").expression = 'var bounds = parent.sourceRectAtTime(time, false); [bounds.width + Math.max(0,effect("Padding X")(1))*2, bounds.height + Math.max(0,effect("Padding Y")(1))*2];';
            rectangle.property("ADBE Vector Rect Position").expression = 'var bounds = parent.sourceRectAtTime(time, false); [bounds.left + bounds.width/2, bounds.top + bounds.height/2];';
            rectangle.property("ADBE Vector Rect Roundness").expression = 'Math.max(0,effect("Corner Radius")(1));';
            contents.property(2).property("ADBE Vector Fill Color").expression = 'effect("Fill Color")(1);';
            return true;
        });
    });
}

function csWorkbenchTextRanges(text, mode) {
    var ranges = [];
    var pattern = mode === "lines" ? /[^\r\n]+/g : mode === "letters" ? /[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\s]/g : /\S+/g;
    var match;
    while ((match = pattern.exec(text)) !== null) ranges.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
    return ranges;
}

function csWorkbenchHideTextRange(selectors, start, end) {
    if (end <= start) return;
    var selector = selectors.addProperty("ADBE Text Selector");
    var advanced = selector.property("ADBE Text Range Advanced");
    advanced.property("ADBE Text Range Units").setValue(2);
    advanced.property("ADBE Text Selector Smoothness").setValue(0);
    selector.property("ADBE Text Index Start").setValue(start);
    selector.property("ADBE Text Index End").setValue(end);
}

function toolkitSplitText(optionsHex) {
    var options;
    try { options = jsonParse(decodeBridge(optionsHex)); } catch (error) { return encodeBridge("Invalid splitter options."); }
    if (!options || !/^(letters|words|lines)$/.test(options.mode)) return encodeBridge("Invalid split mode.");
    var stagger = Math.max(0, Math.min(3, Math.round(Number(options.stagger) || 0)));
    return csWorkbenchRun("Split Text", true, function (comp, layers) {
        if (layers.length !== 1 || !(layers[0] instanceof TextLayer)) return "PRE:text:Select one text layer.";
        var source = layers[0];
        if (source.locked) return "PRE:locked:Unlock the text layer first.";
        if (csWorkbenchHasExpression(source)) return "PRE:text:Remove layer expressions before splitting.";
        if (source.property("ADBE Text Properties").property("ADBE Text Animators").numProperties) return "PRE:text:Remove existing text animators before splitting.";
        if (source.hasTrackMatte || source.isTrackMatte) return "PRE:text:Remove track matte relationships before splitting.";
        var textProperty = source.property("ADBE Text Properties").property("ADBE Text Document");
        if (textProperty.numKeys || textProperty.expressionEnabled) return "PRE:text:Use static Source Text before splitting.";
        var fullText = textProperty.value.text;
        var ranges = csWorkbenchTextRanges(fullText, options.mode);
        if (!ranges.length || ranges.length > 200) return "PRE:text:Split between 1 and 200 text pieces at a time.";
        var master = comp.layers.addNull();
        master.name = source.name + " - Master";
        master.threeDLayer = source.threeDLayer;
        master.parent = source.parent;
        master.inPoint = source.inPoint;
        master.outPoint = Math.min(comp.duration, source.outPoint + (ranges.length - 1) * stagger * comp.frameDuration);
        master.moveBefore(source);
        for (var rangeIndex = 0; rangeIndex < ranges.length; rangeIndex++) {
            var range = ranges[rangeIndex];
            var piece = source.duplicate();
            piece.name = range.text;
            var animators = piece.property("ADBE Text Properties").property("ADBE Text Animators");
            var animator = animators.addProperty("ADBE Text Animator");
            animator.name = "CompSaver Isolate " + (rangeIndex + 1);
            animator.property("ADBE Text Animator Properties").addProperty("ADBE Text Opacity").setValue(0);
            var selectors = animator.property("ADBE Text Selectors");
            csWorkbenchHideTextRange(selectors, 0, range.start);
            csWorkbenchHideTextRange(selectors, range.end, fullText.length);
            piece.parent = master;
            piece.startTime += rangeIndex * stagger * comp.frameDuration;
        }
        source.enabled = false;
        return "OK:Created " + ranges.length + " text pieces and a master null; original retained";
    });
}

function csWorkbenchHasExpression(group) {
    if (group.expressionEnabled) return true;
    for (var propertyIndex = 1; propertyIndex <= group.numProperties; propertyIndex++) {
        if (csWorkbenchHasExpression(group.property(propertyIndex))) return true;
    }
    return false;
}

function toolkitApplyOneFramer(recipeHex) {
    var recipe;
    try { recipe = jsonParse(decodeBridge(recipeHex)); } catch (error) { return encodeBridge("Invalid One-Framer recipe."); }
    if (!recipe || typeof recipe.name !== "string" || !(recipe.effects instanceof Array) || !recipe.effects.length || recipe.effects.length > 64) return encodeBridge("Invalid One-Framer recipe.");
    if (recipe.blend && recipe.blend !== "overlay" && recipe.blend !== "screen") return encodeBridge("Invalid One-Framer blend mode.");
    return csWorkbenchRun("One-Framer: " + recipe.name, true, function (comp, layers) {
        return csWorkbenchEach(layers, recipe.name, function (layer) {
            if (!csWorkbenchIsAVLayer(layer)) return "Select footage, text or shape layers";
            var effects = layer.property("ADBE Effect Parade");
            if (!effects) return "Layer does not support effects";
            var plan = [];
            for (var effectIndex = 0; effectIndex < recipe.effects.length; effectIndex++) {
                var definition = recipe.effects[effectIndex];
                var alternatives = typeof definition.mn === "string" ? [definition.mn] : definition.mn;
                if (!(alternatives instanceof Array) || !alternatives.length || !(definition.p instanceof Array)) return "Invalid effect definition";
                var matchName = null;
                for (var alternateIndex = 0; alternateIndex < alternatives.length; alternateIndex++) {
                    if (typeof alternatives[alternateIndex] === "string" && effects.canAddProperty(alternatives[alternateIndex])) { matchName = alternatives[alternateIndex]; break; }
                }
                if (!matchName) return "Missing effect/plugin: " + alternatives[0];
                plan.push(matchName);
            }
            var originalCount = effects.numProperties;
            var originalBlend = layer.blendingMode;
            try {
                for (var planIndex = 0; planIndex < plan.length; planIndex++) {
                    var effect = effects.addProperty(plan[planIndex]);
                    var parameters = recipe.effects[planIndex].p;
                    for (var parameterIndex = 0; parameterIndex < parameters.length; parameterIndex++) {
                        var pair = parameters[parameterIndex];
                        if (!(pair instanceof Array) || pair.length !== 2 || typeof pair[0] !== "number" || pair[0] < 1 || pair[0] !== Math.floor(pair[0])) throw new Error("Invalid effect parameter");
                        var property = effect.property(pair[0]);
                        if (!property) throw new Error("Unavailable parameter " + pair[0] + " in " + plan[planIndex]);
                        property.setValue(pair[1]);
                    }
                }
                if (recipe.blend) layer.blendingMode = recipe.blend === "overlay" ? BlendingMode.OVERLAY : BlendingMode.SCREEN;
            } catch (applyError) {
                while (effects.numProperties > originalCount) effects.property(effects.numProperties).remove();
                layer.blendingMode = originalBlend;
                return "Recipe not applied: " + applyError.toString();
            }
            return true;
        });
    });
}

function csWorkbenchReplaceLiteral(text, find, replacement, matchCase) {
    if (matchCase) return text.split(find).join(replacement);
    var escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(escaped, "gi"), function () { return replacement; });
}

function toolkitFindReplaceText(optionsHex) {
    var options;
    try { options = jsonParse(decodeBridge(optionsHex)); } catch (error) { return encodeBridge("Invalid find and replace options."); }
    if (!options || typeof options.find !== "string" || !options.find || typeof options.replace !== "string" || !/^(selection|comp|project)$/.test(options.scope)) return encodeBridge("PRE:text:Enter text to find and a valid scope.");
    return csWorkbenchRun("Find and Replace Text", false, function (comp, selected) {
        var layers = [];
        var itemIndex;
        var layerIndex;
        if (options.scope === "selection") layers = selected;
        else {
            var comps = [comp];
            if (options.scope === "project") {
                comps = [];
                for (itemIndex = 1; itemIndex <= app.project.numItems; itemIndex++) {
                    if (app.project.item(itemIndex) instanceof CompItem) comps.push(app.project.item(itemIndex));
                }
            }
            for (itemIndex = 0; itemIndex < comps.length; itemIndex++) {
                for (layerIndex = 1; layerIndex <= comps[itemIndex].numLayers; layerIndex++) layers.push(comps[itemIndex].layer(layerIndex));
            }
        }
        var changed = 0;
        var skipped = 0;
        for (layerIndex = 0; layerIndex < layers.length; layerIndex++) {
            var layer = layers[layerIndex];
            if (!(layer instanceof TextLayer)) continue;
            var property = layer.property("ADBE Text Properties").property("ADBE Text Document");
            if (layer.locked || property.expressionEnabled) { skipped++; continue; }
            var edits = Math.max(1, property.numKeys);
            var changedLayer = false;
            for (var keyIndex = 1; keyIndex <= edits; keyIndex++) {
                var textDocument = property.numKeys ? property.keyValue(keyIndex) : property.value;
                var replacement = csWorkbenchReplaceLiteral(textDocument.text, options.find, options.replace, options.matchCase === true);
                if (replacement !== textDocument.text) {
                    textDocument.text = replacement;
                    if (property.numKeys) property.setValueAtKey(keyIndex, textDocument);
                    else property.setValue(textDocument);
                    changedLayer = true;
                }
            }
            if (changedLayer) changed++;
        }
        return "OK:Updated " + changed + " text layer(s)" + (skipped ? "; skipped " + skipped + " locked or expression-driven layer(s)" : "");
    });
}
