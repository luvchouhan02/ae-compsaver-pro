// ============================================================
// tests/helpers/aeFakes.js
// Inspectable, call-recording fakes for the minimal After Effects DOM
// surface exercised by the engine-robustness-hardening backbone helpers.
//
// Feature: engine-robustness-hardening
//
// These fakes stand in for the AE DOM inside Node/Jest. They record call
// order and mutations so spy tests can assert wiring (e.g. that
// ensurePropertyVisible runs before setPropertyValueSafe, or that
// beginSuppressDialogs brackets a render). They deliberately avoid any real
// AE behavior: they only emulate the shape the helpers touch.
//
// Design notes:
//  - A shared `recorder` can be threaded through every fake so tests can
//    assert *global* call ordering across property/layer/comp/app objects.
//  - Every fake also keeps its own `.calls` log for local assertions.
//  - Any method can be made to throw via the `throws` option (a map of
//    methodName -> true|Error|fn) so generators can fold in DOM failures.
//  - Getters/setters for scalar attributes are optionally recorded and can
//    be made to throw, mirroring AE attributes that reject writes.
// ============================================================

"use strict";

/**
 * Create a shared recorder. Threading one recorder through multiple fakes
 * yields a single, ordered event journal across all of them.
 */
function createRecorder() {
    var events = [];
    return {
        events: events,
        /** Record a named event against a target label. */
        record: function (target, name, args) {
            events.push({ target: target, name: name, args: args || [] });
        },
        /** Ordered list of "target.name" strings, handy for wiring assertions. */
        sequence: function () {
            var out = [];
            for (var i = 0; i < events.length; i++) {
                out.push(events[i].target + "." + events[i].name);
            }
            return out;
        },
        /** All events matching a given method name. */
        byName: function (name) {
            var out = [];
            for (var i = 0; i < events.length; i++) {
                if (events[i].name === name) out.push(events[i]);
            }
            return out;
        },
        clear: function () {
            events.length = 0;
        },
    };
}

// Internal: resolve a `throws` entry into an action. Returns undefined when
// the method should not throw, otherwise throws the configured error.
function maybeThrow(throwsMap, key) {
    if (!throwsMap) return;
    var t = throwsMap[key];
    if (!t) return;
    if (typeof t === "function") {
        // Allow a predicate/producer; if it returns falsy, do not throw.
        var produced = t();
        if (!produced) return;
        throw produced instanceof Error ? produced : new Error(String(produced));
    }
    if (t instanceof Error) throw t;
    throw new Error("Fake DOM error on '" + key + "'");
}

// Internal: attach a recorded, optionally-throwing scalar attribute.
// Keeps a plain backing field but funnels reads/writes through the recorder
// and the `throws` map so tests can observe and inject failures.
function defineRecordedAttr(obj, label, name, recorder, throwsMap, initial, ownCalls) {
    var backing = initial;
    Object.defineProperty(obj, name, {
        enumerable: true,
        configurable: true,
        get: function () {
            maybeThrow(throwsMap, "get:" + name);
            if (recorder) recorder.record(label, "get:" + name, []);
            ownCalls.push({ name: "get:" + name, args: [] });
            return backing;
        },
        set: function (v) {
            maybeThrow(throwsMap, "set:" + name);
            if (recorder) recorder.record(label, "set:" + name, [v]);
            ownCalls.push({ name: "set:" + name, args: [v] });
            backing = v;
        },
    });
}

/**
 * Property fake.
 * Surface: hidden, parentProperty, numKeys, selected, expressionEnabled,
 *          setValueAtTime, addKey, setValueAtKey, setValue, value
 *
 * options:
 *   label            string label used in recorder events (default "prop")
 *   recorder         shared recorder (optional)
 *   throws           map of key -> throw spec. Keys are method names
 *                    (setValueAtTime, addKey, setValueAtKey, setValue) or
 *                    "get:<attr>" / "set:<attr>" for scalar attributes.
 *   hidden, numKeys, selected, expressionEnabled, value, parentProperty
 *                    initial attribute values.
 */
function createPropertyFake(options) {
    options = options || {};
    var recorder = options.recorder || null;
    var label = options.label || "prop";
    var throwsMap = options.throws || {};
    var ownCalls = [];
    var keyframes = []; // { time, value } written via setValueAtTime/keys

    var prop = {
        calls: ownCalls,
        keyframes: keyframes,
        // History of every value landed (via any write path) for assertions.
        valueHistory: [],
    };

    // Scalar/attribute surface (recorded + throwable).
    defineRecordedAttr(prop, label, "hidden", recorder, throwsMap,
        options.hidden !== undefined ? options.hidden : false, ownCalls);
    defineRecordedAttr(prop, label, "parentProperty", recorder, throwsMap,
        options.parentProperty !== undefined ? options.parentProperty : null, ownCalls);
    defineRecordedAttr(prop, label, "numKeys", recorder, throwsMap,
        options.numKeys !== undefined ? options.numKeys : 0, ownCalls);
    defineRecordedAttr(prop, label, "selected", recorder, throwsMap,
        options.selected !== undefined ? options.selected : false, ownCalls);
    defineRecordedAttr(prop, label, "expressionEnabled", recorder, throwsMap,
        options.expressionEnabled !== undefined ? options.expressionEnabled : false, ownCalls);

    // `value` is plain state (not a recorded wiring event): the write methods
    // below mutate it internally, and recording those internal mutations would
    // pollute call-order assertions. Tests observe landed values via
    // `prop.value`, `prop.valueHistory`, and `prop.keyframes` instead.
    prop.value = options.value !== undefined ? options.value : null;

    prop.setValueAtTime = function (time, value) {
        maybeThrow(throwsMap, "setValueAtTime");
        if (recorder) recorder.record(label, "setValueAtTime", [time, value]);
        ownCalls.push({ name: "setValueAtTime", args: [time, value] });
        keyframes.push({ time: time, value: value });
        prop.value = value;
        prop.valueHistory.push(value);
    };

    prop.addKey = function (time) {
        maybeThrow(throwsMap, "addKey");
        if (recorder) recorder.record(label, "addKey", [time]);
        ownCalls.push({ name: "addKey", args: [time] });
        keyframes.push({ time: time, value: undefined });
        prop.numKeys = keyframes.length;
        return keyframes.length; // 1-based key index, AE-style
    };

    prop.setValueAtKey = function (index, value) {
        maybeThrow(throwsMap, "setValueAtKey");
        if (recorder) recorder.record(label, "setValueAtKey", [index, value]);
        ownCalls.push({ name: "setValueAtKey", args: [index, value] });
        var slot = index - 1;
        if (keyframes[slot]) keyframes[slot].value = value;
        prop.value = value;
        prop.valueHistory.push(value);
    };

    prop.setValue = function (value) {
        maybeThrow(throwsMap, "setValue");
        if (recorder) recorder.record(label, "setValue", [value]);
        ownCalls.push({ name: "setValue", args: [value] });
        prop.value = value;
        prop.valueHistory.push(value);
    };

    return prop;
}

/**
 * Layer fake.
 * Surface: locked, shy, enabled, selected, source, width, height, property(...)
 *
 * options:
 *   label      string label used in recorder events (default "layer")
 *   recorder   shared recorder (optional)
 *   throws     map of key -> throw spec. Method key: "property".
 *              Scalar keys: "get:<attr>" / "set:<attr>".
 *   properties map of propertyName -> property fake (or options) returned by
 *              property(name). Missing names return a fresh default property
 *              fake (recorded) so callers never get undefined unexpectedly.
 *   locked, shy, enabled, selected, source, width, height  initial values.
 */
function createLayerFake(options) {
    options = options || {};
    var recorder = options.recorder || null;
    var label = options.label || "layer";
    var throwsMap = options.throws || {};
    var ownCalls = [];
    var propertyMap = options.properties || {};

    var layer = {
        calls: ownCalls,
        // Cache of property fakes handed out, keyed by requested name.
        resolvedProperties: {},
    };

    defineRecordedAttr(layer, label, "locked", recorder, throwsMap,
        options.locked !== undefined ? options.locked : false, ownCalls);
    defineRecordedAttr(layer, label, "shy", recorder, throwsMap,
        options.shy !== undefined ? options.shy : false, ownCalls);
    defineRecordedAttr(layer, label, "enabled", recorder, throwsMap,
        options.enabled !== undefined ? options.enabled : true, ownCalls);
    defineRecordedAttr(layer, label, "selected", recorder, throwsMap,
        options.selected !== undefined ? options.selected : false, ownCalls);
    defineRecordedAttr(layer, label, "source", recorder, throwsMap,
        options.source !== undefined ? options.source : null, ownCalls);
    defineRecordedAttr(layer, label, "width", recorder, throwsMap,
        options.width !== undefined ? options.width : undefined, ownCalls);
    defineRecordedAttr(layer, label, "height", recorder, throwsMap,
        options.height !== undefined ? options.height : undefined, ownCalls);

    layer.property = function (name) {
        maybeThrow(throwsMap, "property");
        if (recorder) recorder.record(label, "property", [name]);
        ownCalls.push({ name: "property", args: [name] });
        if (layer.resolvedProperties[name]) return layer.resolvedProperties[name];
        var configured = propertyMap[name];
        var resolved;
        if (configured && typeof configured.setValue === "function") {
            // Already a property fake.
            resolved = configured;
        } else {
            // Options object (or undefined) -> build a labeled property fake.
            var propOpts = configured || {};
            propOpts = Object.assign({}, propOpts);
            if (!propOpts.recorder) propOpts.recorder = recorder;
            if (!propOpts.label) propOpts.label = label + "." + name;
            resolved = createPropertyFake(propOpts);
        }
        layer.resolvedProperties[name] = resolved;
        return resolved;
    };

    return layer;
}

/**
 * Comp (CompItem) fake.
 * Surface: time, width, height, hideShyLayers, openInViewer, layers
 *
 * options:
 *   label       string label used in recorder events (default "comp")
 *   recorder    shared recorder (optional)
 *   throws      map of key -> throw spec. Method key: "openInViewer".
 *               Scalar keys: "get:<attr>" / "set:<attr>".
 *   isComp      marks the object as a CompItem for resolveActiveComp tests
 *               (default true). Sets constructor-name-ish flag.
 *   time, width, height, hideShyLayers, layers  initial values.
 */
function createCompFake(options) {
    options = options || {};
    var recorder = options.recorder || null;
    var label = options.label || "comp";
    var throwsMap = options.throws || {};
    var ownCalls = [];

    var comp = {
        calls: ownCalls,
        // Marker so resolveActiveComp-style checks can identify a CompItem.
        // (ExtendScript uses `instanceof CompItem`; the shim can expose a
        // CompItem constructor whose fakes satisfy it — see loadHelpers.)
        __isCompFake: options.isComp !== undefined ? options.isComp : true,
    };

    defineRecordedAttr(comp, label, "time", recorder, throwsMap,
        options.time !== undefined ? options.time : 0, ownCalls);
    defineRecordedAttr(comp, label, "width", recorder, throwsMap,
        options.width !== undefined ? options.width : 1920, ownCalls);
    defineRecordedAttr(comp, label, "height", recorder, throwsMap,
        options.height !== undefined ? options.height : 1080, ownCalls);
    defineRecordedAttr(comp, label, "hideShyLayers", recorder, throwsMap,
        options.hideShyLayers !== undefined ? options.hideShyLayers : false, ownCalls);
    defineRecordedAttr(comp, label, "layers", recorder, throwsMap,
        options.layers !== undefined ? options.layers : [], ownCalls);

    comp.openInViewer = function () {
        maybeThrow(throwsMap, "openInViewer");
        if (recorder) recorder.record(label, "openInViewer", []);
        ownCalls.push({ name: "openInViewer", args: [] });
        return comp;
    };

    return comp;
}

/**
 * App fake.
 * Surface: project.activeItem/selection/numItems,
 *          beginUndoGroup/endUndoGroup,
 *          beginSuppressDialogs/endSuppressDialogs
 *
 * options:
 *   label        string label used in recorder events (default "app")
 *   recorder     shared recorder (optional)
 *   throws       map of key -> throw spec. Method keys: beginUndoGroup,
 *                endUndoGroup, beginSuppressDialogs, endSuppressDialogs.
 *                Also project attribute keys "get:activeItem" etc.
 *   activeItem   initial project.activeItem
 *   selection    initial project.selection (array)
 *   numItems     initial project.numItems (Number)
 *   items        optional 1-based item accessor backing (array); when present
 *                project.item(i) returns items[i-1] (AE is 1-based).
 */
function createAppFake(options) {
    options = options || {};
    var recorder = options.recorder || null;
    var label = options.label || "app";
    var throwsMap = options.throws || {};
    var ownCalls = [];

    var openUndoGroups = 0;
    var suppressDepth = 0;

    var project = { calls: [] };
    defineRecordedAttr(project, label + ".project", "activeItem", recorder, throwsMap,
        options.activeItem !== undefined ? options.activeItem : null, project.calls);
    defineRecordedAttr(project, label + ".project", "selection", recorder, throwsMap,
        options.selection !== undefined ? options.selection : [], project.calls);
    defineRecordedAttr(project, label + ".project", "numItems", recorder, throwsMap,
        options.numItems !== undefined ? options.numItems : 0, project.calls);

    if (options.items) {
        var items = options.items;
        project.item = function (i) {
            maybeThrow(throwsMap, "item");
            if (recorder) recorder.record(label + ".project", "item", [i]);
            project.calls.push({ name: "item", args: [i] });
            return items[i - 1]; // AE item() is 1-based
        };
    }

    var app = {
        calls: ownCalls,
        project: project,
        // Introspection helpers for undo-balance / suppression assertions.
        openUndoGroups: function () { return openUndoGroups; },
        suppressDepth: function () { return suppressDepth; },
    };

    app.beginUndoGroup = function (name) {
        maybeThrow(throwsMap, "beginUndoGroup");
        if (recorder) recorder.record(label, "beginUndoGroup", [name]);
        ownCalls.push({ name: "beginUndoGroup", args: [name] });
        openUndoGroups++;
    };

    app.endUndoGroup = function () {
        maybeThrow(throwsMap, "endUndoGroup");
        if (recorder) recorder.record(label, "endUndoGroup", []);
        ownCalls.push({ name: "endUndoGroup", args: [] });
        if (openUndoGroups > 0) openUndoGroups--;
    };

    app.beginSuppressDialogs = function () {
        maybeThrow(throwsMap, "beginSuppressDialogs");
        if (recorder) recorder.record(label, "beginSuppressDialogs", []);
        ownCalls.push({ name: "beginSuppressDialogs", args: [] });
        suppressDepth++;
    };

    app.endSuppressDialogs = function (alert) {
        maybeThrow(throwsMap, "endSuppressDialogs");
        if (recorder) recorder.record(label, "endSuppressDialogs", [alert]);
        ownCalls.push({ name: "endSuppressDialogs", args: [alert] });
        if (suppressDepth > 0) suppressDepth--;
    };

    return app;
}

/**
 * File fake for isValidPng / renderFrameToPng tests.
 * Surface: exists, length  (AE File-like)
 */
function createFileFake(options) {
    options = options || {};
    return {
        exists: options.exists !== undefined ? options.exists : false,
        length: options.length !== undefined ? options.length : 0,
        fsName: options.fsName || "/fake/frame.png",
    };
}

module.exports = {
    createRecorder: createRecorder,
    createPropertyFake: createPropertyFake,
    createLayerFake: createLayerFake,
    createCompFake: createCompFake,
    createAppFake: createAppFake,
    createFileFake: createFileFake,
};
