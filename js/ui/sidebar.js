// ============================================================
// ui/sidebar.js - Sidebar items to router, aria-current, palette trigger
// ------------------------------------------------------------
// CompSaverSidebar is the only writer of Sidebar state. One click listener
// per item; Enter and Space on a focused <button> fire click, so pointer and
// keyboard share one path. Req 6.5, 7.1, 7.2, 7.3, 7.5, 7.9, 7.10, 7.11, 18.8.
// ============================================================
(function (root) {
    "use strict";

    var ITEMS = [
        { id: "btn-sidebar-templates", route: "templates", label: "Templates" },
        { id: "btn-sidebar-kit", route: "tools", label: "Workbench" },
        { id: "btn-sidebar-fx", route: "effects", label: "Effects" },
        { id: "btn-sidebar-type", route: "text", label: "Text" },
        { id: "btn-sidebar-flow", route: "easing", label: "Flow" },
        { id: "btn-sidebar-colors", route: "colorflow", label: "Colors" },
        { id: "btn-sidebar-settings", route: "settings", label: "Settings" },
        { id: "btn-sidebar-palette", route: null, command: "palette", label: "Commands" }
    ];
    for (var f = 0; f < ITEMS.length; f++) if (typeof Object.freeze === "function") Object.freeze(ITEMS[f]);
    if (typeof Object.freeze === "function") Object.freeze(ITEMS);

    function createSidebar() {
        var deps = {};
        var bound = false;
        var unsubscribe = null;

        function router() { return deps.router || root.CompSaverRouter || null; }
        function palette() { return deps.palette || root.CommandPalette || null; }
        function doc() { return deps.doc || (typeof document !== "undefined" ? document : null); }
        function toast(msg, type) {
            var fn = deps.showToast || (typeof root.showToast === "function" ? root.showToast : null);
            if (fn) fn(msg, type);
        }

        function byId(id) {
            var d = doc();
            return d && typeof d.getElementById === "function" ? d.getElementById(id) : null;
        }

        function itemById(id) {
            for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i].id === id) return ITEMS[i];
            return null;
        }

        function itemForRoute(route) {
            for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i].route === route && route !== null) return ITEMS[i];
            return null;
        }

        function applyRoute(route) {
            var marked = 0;
            for (var i = 0; i < ITEMS.length; i++) {
                var el = byId(ITEMS[i].id);
                if (!el) continue;
                if (ITEMS[i].route !== null && ITEMS[i].route === route) {
                    el.setAttribute("aria-current", "page");
                    marked++;
                } else if (typeof el.removeAttribute === "function") {
                    el.removeAttribute("aria-current");
                }
            }
            return marked;
        }

        function activate(itemId, source) {
            var item = itemById(itemId);
            if (!item) return { ok: false, code: "UNKNOWN_ITEM" };
            if (item.command === "palette") {
                var p = palette();
                if (p && typeof p.open === "function") p.open();
                return { ok: true, command: "palette" };
            }
            var r = router();
            if (!r || typeof r.go !== "function") return { ok: false, code: "ROUTER_UNAVAILABLE" };
            if (typeof r.current === "function" && r.current() === item.route) return { ok: true, route: item.route, unchanged: true };
            var result = r.go(item.route, { source: source || "sidebar" });
            if (!result || result.ok !== true) {
                // Shown after the rollback, so the legacy switchers' clearToast() cannot swallow it.
                toast("\u2715 Couldn't open " + item.label + ". Reload the panel to try again.", "error");
            }
            return result;
        }

        function focusActive() {
            for (var i = 0; i < ITEMS.length; i++) {
                var el = byId(ITEMS[i].id);
                if (el && typeof el.getAttribute === "function" && el.getAttribute("aria-current") === "page") {
                    if (typeof el.focus === "function") el.focus();
                    return true;
                }
            }
            return false;
        }

        function init(options) {
            if (options) {
                var keys = ["router", "palette", "showToast", "doc"];
                for (var k = 0; k < keys.length; k++) {
                    if (Object.prototype.hasOwnProperty.call(options, keys[k])) deps[keys[k]] = options[keys[k]];
                }
            }
            if (bound) return api;
            bound = true;
            for (var i = 0; i < ITEMS.length; i++) {
                (function (item) {
                    var el = byId(item.id);
                    if (!el || typeof el.addEventListener !== "function") return;
                    el.addEventListener("click", function () { activate(item.id, "sidebar"); });
                })(ITEMS[i]);
            }
            var r = router();
            if (r && typeof r.onChange === "function") {
                unsubscribe = r.onChange(function (route) { applyRoute(route); });
            }
            if (r && typeof r.current === "function") {
                var cur = r.current();
                if (cur) applyRoute(cur);
            }
            return api;
        }

        var api = {
            ITEMS: ITEMS,
            init: init,
            activate: activate,
            applyRoute: applyRoute,
            itemForRoute: itemForRoute,
            focusActive: focusActive,
            dispose: function () { if (typeof unsubscribe === "function") unsubscribe(); unsubscribe = null; }
        };
        return api;
    }

    var CompSaverSidebar = createSidebar();
    CompSaverSidebar.create = createSidebar;
    root.CompSaverSidebar = CompSaverSidebar;
    if (typeof module !== "undefined" && module.exports) module.exports = CompSaverSidebar;
})(typeof window !== "undefined" ? window : globalThis);
