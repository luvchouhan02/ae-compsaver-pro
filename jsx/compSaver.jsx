// CompSaver ExtendScript Host
// Entry point - split into modules via ExtendScript //@include preprocessor.
// Order = original top-to-bottom (preserves evaluation order).

//@include "core.jsx"
//@include "helpers.jsx"
//@include "templates_save.jsx"
//@include "toolkit.jsx"
//@include "import.jsx"
//@include "workflow.jsx"
//@include "text.jsx"
//@include "workbench.jsx"

// Single parent null - creates ONE null for all selected layers (normal click)
// Shift+click still uses toolkitCreateLayer("null") for per-layer nulls
function toolkitCreateParentNull() {
    try {
        var comp = toolkitGetActiveComp();
        if (!comp) return encodeBridge("Open a composition first.");
        var selectedLayers = [];
        for (var i = 0; i < comp.selectedLayers.length; i++) selectedLayers.push(comp.selectedLayers[i]);
        if (selectedLayers.length === 0) { app.beginUndoGroup("Create Null"); comp.layers.addNull(); app.endUndoGroup(); return encodeBridge("true"); }
        if (selectedLayers.length === 1) return toolkitCreateLayer(encodeBridge("null"));
        app.beginUndoGroup("Create Parent Null");
        var nullLayer = comp.layers.addNull();
        nullLayer.name = "Parent Null";
        var any3D = false;
        for (var j = 0; j < selectedLayers.length; j++) { try { if (selectedLayers[j].threeDLayer) { any3D = true; break; } } catch (e) { } }
        if (any3D) { try { nullLayer.threeDLayer = true; } catch (e) { } }
        var earliest = comp.duration, latest = 0;
        for (var k = 0; k < selectedLayers.length; k++) { try { if (selectedLayers[k].inPoint < earliest) earliest = selectedLayers[k].inPoint; if (selectedLayers[k].outPoint > latest) latest = selectedLayers[k].outPoint; } catch (e) { } }
        try { nullLayer.startTime = earliest; } catch (e) { }
        try { nullLayer.outPoint = latest; } catch (e) { }
        for (var m = 0; m < selectedLayers.length; m++) { try { var wasLocked = selectedLayers[m].locked; if (wasLocked) selectedLayers[m].locked = false; selectedLayers[m].parent = nullLayer; if (wasLocked) selectedLayers[m].locked = true; } catch (ePar) { } }
        app.endUndoGroup();
        return encodeBridge("true");
    } catch (e) { try { app.endUndoGroup(); } catch (eu) { } return encodeBridge("Error: " + e.toString()); }
}
