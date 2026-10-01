"use strict";

const ShellState = require("../js/ui/shell-state");

function expectCode(action, code) {
    let error;
    try { action(); } catch (caught) { error = caught; }
    expect(error).toBeDefined();
    expect(error.code).toBe(code);
}

function makeAdapter(name, log, options = {}) {
    return {
        activate(context) {
            log.push(`${name}.activate`);
            if (options.activateError) throw new Error(options.activateError);
            options.lastActivation = context;
        },
        deactivate() {
            log.push(`${name}.deactivate`);
            if (options.deactivateError) throw new Error(options.deactivateError);
        },
        render(state) { options.lastRender = state; },
        handleAction(actionId, payload) { return { actionId, payload }; },
        getRestorationState() {
            log.push(`${name}.capture`);
            if (options.captureError) throw new Error(options.captureError);
            return options.capture || null;
        },
        restore(restoration) {
            log.push(`${name}.restore`);
            options.lastRestoration = restoration;
            if (options.restoreError) throw new Error(options.restoreError);
        },
        getPrimaryAction() { return options.primaryAction || null; }
    };
}

describe("CompSaver semantic shell state", () => {
    test("defines exactly seven routes and exactly one active route", () => {
        expect(ShellState.routes).toEqual([
            "templates", "tools", "effects", "text", "easing", "colorflow", "settings"
        ]);
        const model = ShellState.create();
        const state = model.getState();
        expect(state.activeRoute).toBe("templates");
        expect(Object.keys(state.routes)).toEqual(ShellState.routes);
        expect(ShellState.routes.filter((routeId) => routeId === state.activeRoute)).toHaveLength(1);
        expect(state.activeAdapterRoute).toBeNull();
    });

    test("initializes explicit semantic restoration state for every route", () => {
        const model = ShellState.create();
        ShellState.routes.forEach((routeId) => {
            expect(model.getRouteState(routeId)).toEqual({
                subsection: null,
                selectedIds: [],
                bulkMode: false,
                drafts: {},
                scrollToken: null,
                focusToken: null,
                revision: 0
            });
        });
        expect(model.getState().context).toEqual({ compName: "", templateCount: 0, bridgeStatus: "ready" });
    });


    test("retains route-local state without exposing mutable references", () => {
        const model = ShellState.create();
        const drafts = { save: { name: "Draft A", tags: ["one"] } };
        model.updateRouteState("templates", {
            subsection: "composition",
            selectedIds: ["asset-1", 2],
            bulkMode: true,
            drafts,
            scrollToken: 240,
            focusToken: "asset:asset-1:apply"
        });
        drafts.save.name = "mutated outside";
        const state = model.getRouteState("templates");
        expect(state).toEqual({
            subsection: "composition",
            selectedIds: ["asset-1", 2],
            bulkMode: true,
            drafts: { save: { name: "Draft A", tags: ["one"] } },
            scrollToken: 240,
            focusToken: "asset:asset-1:apply",
            revision: 1
        });
        state.selectedIds.push("external");
        state.drafts.save.tags.push("external");
        expect(model.getRouteState("templates").selectedIds).toEqual(["asset-1", 2]);
        expect(model.getRouteState("templates").drafts.save.tags).toEqual(["one"]);
    });

    test("responsive transitions change presentation mode only", () => {
        const model = ShellState.create();
        model.updateRouteState("easing", {
            subsection: "user",
            selectedIds: ["curve-1"],
            bulkMode: false,
            drafts: { incoming: 33, outgoing: 67 },
            scrollToken: "preset:curve-1",
            focusToken: "easing:apply"
        });
        const before = model.getRouteState("easing");
        expect(model.setResponsiveMode("narrow")).toBe("narrow");
        expect(model.setResponsiveMode("expanded")).toBe("expanded");
        expect(model.getRouteState("easing")).toEqual(before);
        expect(model.getRoute()).toBe("templates");
    });

    test("updates context status through a validated partial contract", () => {
        const model = ShellState.create({ context: { bridgeStatus: "degraded" } });
        expect(model.setContext({ compName: "Main Comp", templateCount: 12 })).toEqual({
            compName: "Main Comp", templateCount: 12, bridgeStatus: "degraded"
        });
        model.setContext({ bridgeStatus: "unavailable" });
        expect(model.getState().context.bridgeStatus).toBe("unavailable");
    });

    test("registers complete adapters without activating them", () => {
        const model = ShellState.create();
        const log = [];
        const adapter = makeAdapter("templates", log);
        expect(model.registerView("templates", adapter)).toBe(adapter);
        expect(model.hasView("templates")).toBe(true);
        expect(model.getRegisteredRoutes()).toEqual(["templates"]);
        expect(log).toEqual([]);
        model.unregisterView("templates");
        expect(model.getRegisteredRoutes()).toEqual([]);
    });


    test("activates, captures, deactivates, and restores adapters in deterministic order", () => {
        const model = ShellState.create();
        const log = [];
        const templateOptions = {
            capture: {
                selectedIds: ["asset-7"], bulkMode: true, drafts: { rename: "A" },
                scrollToken: 77, focusToken: "asset-7", subsection: "images"
            }
        };
        const toolOptions = {};
        model.registerView("templates", makeAdapter("templates", log, templateOptions));
        model.registerView("tools", makeAdapter("tools", log, toolOptions));

        model.navigate("templates", { source: "startup" });
        expect(log).toEqual(["templates.activate", "templates.restore"]);
        expect(templateOptions.lastActivation.source).toBe("startup");
        log.length = 0;

        model.navigate("tools", { source: "navigation", restoreFocus: false });
        expect(log).toEqual([
            "templates.capture", "templates.deactivate", "tools.activate", "tools.restore"
        ]);
        expect(model.getRoute()).toBe("tools");
        expect(model.getState().activeAdapterRoute).toBe("tools");
        expect(model.getRouteState("templates")).toEqual(expect.objectContaining({
            selectedIds: ["asset-7"], bulkMode: true, drafts: { rename: "A" },
            scrollToken: 77, focusToken: "asset-7", subsection: "images", revision: 1
        }));
        expect(toolOptions.lastActivation.restoreFocus).toBe(false);

        log.length = 0;
        model.navigate("templates");
        expect(log).toEqual([
            "tools.capture", "tools.deactivate", "templates.activate", "templates.restore"
        ]);
        expect(templateOptions.lastRestoration.state).toEqual(expect.objectContaining({
            selectedIds: ["asset-7"], drafts: { rename: "A" }, scrollToken: 77, focusToken: "asset-7"
        }));
    });

    test("deactivation captures retained state before allowing unregister", () => {
        const model = ShellState.create();
        const log = [];
        const options = { capture: { subsection: "about", focusToken: "settings:about" } };
        model.registerView("settings", makeAdapter("settings", log, options));
        model.navigate("settings");
        expectCode(() => model.unregisterView("settings"), "ADAPTER_ACTIVE");
        log.length = 0;
        model.deactivate("settings");
        expect(log).toEqual(["settings.capture", "settings.deactivate"]);
        expect(model.getRouteState("settings")).toEqual(expect.objectContaining({
            subsection: "about", focusToken: "settings:about", revision: 1
        }));
        model.unregisterView("settings");
        expect(model.hasView("settings")).toBe(false);
    });

    test("revision-guarded restoration accepts current bytes and rejects stale snapshots", () => {
        const model = ShellState.create();
        const current = model.getRestorationState("colorflow");
        current.state.drafts = { palette: "Brand" };
        const restored = model.applyRestorationState(current);
        expect(restored.drafts).toEqual({ palette: "Brand" });
        expect(restored.revision).toBe(1);
        expectCode(() => model.applyRestorationState(current), "STALE_RESTORATION");
        expect(model.getRouteState("colorflow")).toEqual(restored);
    });


    test("fails closed for unknown route, adapter, mode, context, and route fields", () => {
        const model = ShellState.create();
        const initial = model.getState();
        expectCode(() => model.getRouteState("unknown"), "UNKNOWN_ROUTE");
        expectCode(() => model.navigate("tools"), "UNKNOWN_ADAPTER");
        expectCode(() => model.registerView("tools", { activate() { } }), "INVALID_ADAPTER");
        expectCode(() => model.setResponsiveMode("wide"), "UNKNOWN_RESPONSIVE_MODE");
        expectCode(() => model.setContext({ bridgeStatus: "connected" }), "UNKNOWN_CONTEXT_STATUS");
        expectCode(() => model.setContext({ unknown: true }), "UNKNOWN_CONTEXT_FIELD");
        expectCode(() => model.updateRouteState("templates", { selected: [] }), "UNKNOWN_ROUTE_STATE_FIELD");
        expect(model.getState()).toEqual(initial);
    });

    test("rejects duplicate, unsafe, cyclic, and rendered-object semantic state", () => {
        const model = ShellState.create();
        expectCode(() => model.updateRouteState("templates", { selectedIds: ["a", "a"] }), "INVALID_SELECTION");
        expectCode(() => model.updateRouteState("templates", { drafts: { date: new Date() } }), "NON_SEMANTIC_STATE");
        expectCode(() => model.updateRouteState("templates", { drafts: { action() { } } }), "NON_SEMANTIC_STATE");
        const cyclic = {};
        cyclic.self = cyclic;
        expectCode(() => model.updateRouteState("templates", { drafts: cyclic }), "NON_SEMANTIC_STATE");
        expect(model.getRouteState("templates").revision).toBe(0);
    });

    test("rolls back semantic activation when a target adapter fails", () => {
        const model = ShellState.create();
        const log = [];
        const templateOptions = {};
        const toolOptions = { restoreError: "cannot restore tools" };
        model.registerView("templates", makeAdapter("templates", log, templateOptions));
        model.registerView("tools", makeAdapter("tools", log, toolOptions));
        model.navigate("templates");
        log.length = 0;

        expectCode(() => model.navigate("tools"), "ADAPTER_ACTIVATION_FAILED");
        expect(model.getRoute()).toBe("templates");
        expect(model.getState().activeAdapterRoute).toBe("templates");
        expect(log).toEqual([
            "templates.capture", "templates.deactivate", "tools.activate", "tools.restore",
            "tools.deactivate", "templates.activate", "templates.restore"
        ]);
    });

    test("does not commit captured state when deactivation fails", () => {
        const model = ShellState.create();
        const log = [];
        const templateOptions = {
            capture: { drafts: { pending: true } },
            deactivateError: "still busy"
        };
        model.registerView("templates", makeAdapter("templates", log, templateOptions));
        model.registerView("tools", makeAdapter("tools", log));
        model.navigate("templates");
        log.length = 0;
        expectCode(() => model.navigate("tools"), "ADAPTER_ACTIVATION_FAILED");
        expect(model.getRoute()).toBe("templates");
        expect(model.getRouteState("templates").drafts).toEqual({});
        expect(model.getRouteState("templates").revision).toBe(0);
        expect(log).toEqual(["templates.capture", "templates.deactivate"]);
    });

    test("blocks reentrant semantic mutation during lifecycle callbacks", () => {
        const model = ShellState.create();
        const log = [];
        const adapter = makeAdapter("templates", log);
        adapter.activate = function () {
            model.setResponsiveMode("narrow");
        };
        model.registerView("templates", adapter);
        expectCode(() => model.navigate("templates"), "ADAPTER_ACTIVATION_FAILED");
        expect(model.getState().responsiveMode).toBe("compact");
        expect(model.getState().activeAdapterRoute).toBeNull();
    });
});