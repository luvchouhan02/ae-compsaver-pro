// ============================================================
// ui/toolkit-workbench.js - Workbench tabs, option groups, tool index
// ------------------------------------------------------------
// CompSaverWorkbench owns the four Workbench_Tabs (Layout & Rig, Velocity,
// Text, Guides), the .cs-wb-seg radio groups and the Text Preset Browser
// list. It never calls ToolBridge or the Host: every control declares
// data-toolkit-action and the Toolkit_Dispatcher runs it (Req 9.8, 9.9).
// Req 9.1-9.7, 18.1. No DOM access at load time.
// ============================================================
(function (root) {
    "use strict";

    var TABS = ["layout", "velocity", "text", "guides"];
    var LABELS = { layout: "Layout & Rig", velocity: "Velocity", text: "Text", guides: "Guides" };
    if (typeof Object.freeze === "function") { Object.freeze(TABS); Object.freeze(LABELS); }

    function normalizeTab(value) {
        for (var i = 0; i < TABS.length; i++) if (TABS[i] === value) return value;
        return "layout";
    }

    function nextTab(tab, step) {
        var i = TABS.indexOf(normalizeTab(tab));
        var n = TABS.length;
        return TABS[(((i + (step < 0 ? -1 : 1)) % n) + n) % n];
    }

    /** Pure: integer inside [min, max]; anything else gives the fallback. */
    function normalizeInt(raw, min, max, fallback) {
        var s = typeof raw === "number" ? String(raw) : String(raw == null ? "" : raw).replace(/^\s+|\s+$/g, "");
        if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return fallback;
        var n = Number(s);
        if (!isFinite(n)) return fallback;
        var rounded = Math.floor(n + 0.5);
        if (rounded < min) return min;
        if (rounded > max) return max;
        return rounded;
    }

    var TOOL_INDEX = [
        // ── Layout & Rig ─────────────────────────────────────────────
        { id: "anchor-top-left", tab: "layout", title: "Anchor point: top left", action: "anchor", mode: "", run: "control", focus: null },
        { id: "anchor-top", tab: "layout", title: "Anchor point: top", action: "anchor", mode: "", run: "control", focus: null },
        { id: "anchor-top-right", tab: "layout", title: "Anchor point: top right", action: "anchor", mode: "", run: "control", focus: null },
        { id: "anchor-left", tab: "layout", title: "Anchor point: left", action: "anchor", mode: "", run: "control", focus: null },
        { id: "anchor-center", tab: "layout", title: "Anchor point: center", action: "anchor", mode: "", run: "control", focus: null },
        { id: "anchor-right", tab: "layout", title: "Anchor point: right", action: "anchor", mode: "", run: "control", focus: null },
        { id: "anchor-bottom-left", tab: "layout", title: "Anchor point: bottom left", action: "anchor", mode: "", run: "control", focus: null },
        { id: "anchor-bottom", tab: "layout", title: "Anchor point: bottom", action: "anchor", mode: "", run: "control", focus: null },
        { id: "anchor-bottom-right", tab: "layout", title: "Anchor point: bottom right", action: "anchor", mode: "", run: "control", focus: null },
        { id: "align-left", tab: "layout", title: "Align left edges", action: "align", mode: "left", run: "direct", focus: null },
        { id: "align-hcenter", tab: "layout", title: "Align horizontal centers", action: "align", mode: "hcenter", run: "direct", focus: null },
        { id: "align-right", tab: "layout", title: "Align right edges", action: "align", mode: "right", run: "direct", focus: null },
        { id: "align-top", tab: "layout", title: "Align top edges", action: "align", mode: "top", run: "direct", focus: null },
        { id: "align-vcenter", tab: "layout", title: "Align vertical centers", action: "align", mode: "vcenter", run: "direct", focus: null },
        { id: "align-bottom", tab: "layout", title: "Align bottom edges", action: "align", mode: "bottom", run: "direct", focus: null },
        { id: "precompose", tab: "layout", title: "Smart Precompose", action: "precompose", mode: "", run: "direct", focus: null },
        { id: "multiprecomp", tab: "layout", title: "Multi-Precompose", action: "multiprecomp", mode: "", run: "direct", focus: null },
        { id: "decompose", tab: "layout", title: "De-compose", action: "decompose", mode: "", run: "direct", focus: null },
        { id: "unprecompose", tab: "layout", title: "Un-precompose", action: "unprecompose", mode: "", run: "direct", focus: null },
        { id: "truedup", tab: "layout", title: "True Duplicate", action: "truedup", mode: "", run: "direct", focus: null },
        { id: "crop", tab: "layout", title: "Crop Precomp", action: "crop", mode: "", run: "direct", focus: null },
        { id: "create-null", tab: "layout", title: "Create Null Object", action: "create", mode: "null", run: "direct", focus: null },
        { id: "create-solid", tab: "layout", title: "Create Solid", action: "create", mode: "solid", run: "direct", focus: null },
        { id: "create-adjustment", tab: "layout", title: "Create Adjustment Layer", action: "create", mode: "adjustment", run: "direct", focus: null },
        { id: "create-camera", tab: "layout", title: "Create Camera", action: "create", mode: "camera", run: "direct", focus: null },
        { id: "create-text", tab: "layout", title: "Create Text", action: "create", mode: "text", run: "direct", focus: null },
        { id: "paste", tab: "layout", title: "Paste Image", action: "paste", mode: "", run: "direct", focus: null },
        { id: "delete-expression", tab: "layout", title: "Remove Expressions", action: "delete-expression", mode: "", run: "direct", focus: null },

        // ── Velocity ─────────────────────────────────────────────────
        { id: "sequence", tab: "velocity", title: "Sequence & Stagger", action: "sequence", mode: "", run: "open", focus: "seq-step" },
        { id: "snap-playhead", tab: "velocity", title: "Snap to Playhead", action: "sequence", mode: "down", run: "control", focus: null },
        { id: "bounce", tab: "velocity", title: "Bounce", action: "bounce", mode: "", run: "control", focus: null },
        { id: "bounce-settings", tab: "velocity", title: "Bounce Settings", action: "bounce-settings", mode: "", run: "control", focus: null },

        // ── Text ─────────────────────────────────────────────────────
        { id: "text-preset-browser", tab: "text", title: "Text Preset Browser", action: "text-preset", mode: "", run: "open", focus: "cs-wb-preset-list" },

        // ── Guides ───────────────────────────────────────────────────
        { id: "guides-on", tab: "guides", title: "Guides On", action: "guides-on", mode: "", run: "direct", focus: null },
        { id: "guides-off", tab: "guides", title: "Guides Off", action: "guides-off", mode: "", run: "direct", focus: null },

        // ── Project strip (tab: null) ────────────────────────────────
        { id: "organize", tab: null, title: "Organize Project", action: "organize", mode: "", run: "direct", focus: null },
        { id: "effects", tab: null, title: "Toggle Effects", action: "effects", mode: "", run: "control", focus: null },
        { id: "cache", tab: null, title: "Purge Cache", action: "cache", mode: "", run: "direct", focus: null },
        { id: "resize", tab: null, title: "Resize Comp Tree", action: "resize", mode: "", run: "open", focus: "resize-res" }
    ];

    function createWorkbench() {
        var deps = {};
        var rootEl = null;
        var active = "layout";
        var bound = false;
        var unsubscribePresets = null;

        function doc() { return deps.doc || (typeof document !== "undefined" ? document : null); }
        function q(sel) { return rootEl && typeof rootEl.querySelector === "function" ? rootEl.querySelector(sel) : null; }
        function qa(sel) {
            var out = [];
            if (!rootEl || typeof rootEl.querySelectorAll !== "function") return out;
            var list = rootEl.querySelectorAll(sel);
            for (var i = 0; i < list.length; i++) out.push(list[i]);
            return out;
        }
        function tabEl(tab) { return q('[data-wb-tab="' + tab + '"]'); }
        function panelEl(tab) {
            var d = doc();
            var p = d && typeof d.getElementById === "function" ? d.getElementById("cs-wb-panel-" + tab) : null;
            return p || q("#cs-wb-panel-" + tab);
        }

        function apply(tab, focus) {
            for (var i = 0; i < TABS.length; i++) {
                var t = TABS[i];
                var on = t === tab;
                var b = tabEl(t);
                if (b) {
                    b.setAttribute("aria-selected", on ? "true" : "false");
                    b.setAttribute("tabindex", on ? "0" : "-1");
                }
                var p = panelEl(t);
                if (p) {
                    if (on) { p.hidden = false; if (p.removeAttribute) p.removeAttribute("hidden"); }
                    else { p.hidden = true; if (p.setAttribute) p.setAttribute("hidden", ""); }
                }
            }
            active = tab;
            if (focus) {
                var el = tabEl(tab);
                if (el && typeof el.focus === "function") el.focus();
            }
        }

        function select(tab, options) {
            var t = normalizeTab(tab);
            apply(t, !!(options && options.focus));
            if (typeof deps.onTabChange === "function") {
                try { deps.onTabChange(t); } catch (e) { /* never breaks the switch */ }
            }
            var f = deps.focus || root.CompSaverFocus;
            if (f && typeof f.check === "function") f.check("tab");
            return t;
        }

        function restore(subsection) {
            var t = normalizeTab(subsection);
            apply(t, false);
            return { tab: t, fellBack: t !== subsection };
        }

        // ── .cs-wb-seg radio groups ───────────────────────────────────
        function groupOptions(group) {
            var out = [];
            if (!group || typeof group.querySelectorAll !== "function") return out;
            var list = group.querySelectorAll('[role="radio"]');
            for (var i = 0; i < list.length; i++) out.push(list[i]);
            return out;
        }

        function checkOption(group, option, focus) {
            var opts = groupOptions(group);
            for (var i = 0; i < opts.length; i++) {
                var on = opts[i] === option;
                opts[i].setAttribute("aria-checked", on ? "true" : "false");
                opts[i].setAttribute("tabindex", on ? "0" : "-1");
                if (opts[i].classList) opts[i].classList.toggle("active", on);
            }
            if (focus && option && typeof option.focus === "function") option.focus();
            if (group && typeof group.dispatchEvent === "function" && typeof root.Event === "function") {
                try { group.dispatchEvent(new root.Event("change", { bubbles: true })); } catch (e) { /* ignore */ }
            }
        }

        function bindGroup(group) {
            if (!group || group._csWbBound) return;
            group._csWbBound = true;
            group.addEventListener("click", function (e) {
                var opt = e.target && typeof e.target.closest === "function" ? e.target.closest('[role="radio"]') : null;
                if (opt && group.contains(opt)) checkOption(group, opt, false);
            });
            group.addEventListener("keydown", function (e) {
                var opts = groupOptions(group);
                var idx = opts.indexOf(e.target);
                if (idx < 0) return;
                if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowUp") {
                    e.preventDefault();
                    var step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
                    checkOption(group, opts[(idx + step + opts.length) % opts.length], true);
                } else if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
                    e.preventDefault();
                    checkOption(group, opts[idx], false);
                }
            });
        }

        /** Value of the checked option in the group data-wb-group="<name>". */
        function optionValue(name) {
            var group = q('[data-wb-group="' + name + '"]');
            var opts = groupOptions(group);
            for (var i = 0; i < opts.length; i++) {
                if (opts[i].getAttribute("aria-checked") === "true") return opts[i].getAttribute("data-value");
            }
            return opts.length ? opts[0].getAttribute("data-value") : null;
        }

        function setOption(name, value) {
            var group = q('[data-wb-group="' + name + '"]');
            var opts = groupOptions(group);
            for (var i = 0; i < opts.length; i++) {
                if (opts[i].getAttribute("data-value") === value) { checkOption(group, opts[i], false); return true; }
            }
            return false;
        }

        // ── Text Preset Browser renderer (Req 12.1, 12.11) ───────────
        function renderPresets(targetEl) {
            var d = doc();
            var listEl = targetEl || q("#cs-wb-preset-list") || q('[data-wb-tool="text-preset-browser"]') || (d && d.getElementById("cs-wb-preset-list"));
            if (!listEl) return;

            while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

            var ta = deps.TextAnim || root.TextAnim;
            if (!ta || typeof ta.getPresets !== "function") {
                var unavail = d ? d.createElement("li") : null;
                if (unavail) {
                    unavail.className = "cs-wb-preset-empty";
                    unavail.textContent = "Text presets are unavailable";
                    listEl.appendChild(unavail);
                }
                return;
            }

            var presets = ta.getPresets();
            if (!presets || presets.length === 0) {
                var empty = d ? d.createElement("li") : null;
                if (empty) {
                    empty.className = "cs-wb-preset-empty";
                    empty.textContent = "No text presets yet";
                    listEl.appendChild(empty);
                }
                return;
            }

            if (d) {
                var frag = d.createDocumentFragment();
                for (var i = 0; i < presets.length; i++) {
                    var p = presets[i];
                    var li = d.createElement("li");
                    var btn = d.createElement("button");
                    btn.type = "button";
                    btn.className = "cs-wb-preset-item";
                    btn.setAttribute("data-toolkit-action", "text-preset");
                    btn.setAttribute("data-mode", p.path || "");
                    if (btn.dataset) btn.dataset.mode = p.path || "";
                    btn.textContent = p.displayName || p.path || "Preset";
                    li.appendChild(btn);
                    frag.appendChild(li);
                }
                listEl.appendChild(frag);
            }

            var bind = deps.bindToolkitActionControls || root.bindToolkitActionControls;
            if (typeof bind === "function") {
                try { bind(listEl); } catch (e) { /* ignore */ }
            }
        }

        // ── runTool (Req 1.1, 1.5, 12.1, 12.11, 16.2) ─────────────────
        function runTool(id, options) {
            options = options || {};
            var row = null;
            for (var i = 0; i < TOOL_INDEX.length; i++) {
                if (TOOL_INDEX[i].id === id) { row = TOOL_INDEX[i]; break; }
            }
            if (!row) return { ok: false, code: "unknown-tool" };

            var d = doc();
            if (row.run === "direct") {
                var el = q('[data-wb-tool="' + id + '"]') || (d && d.querySelector ? d.querySelector('[data-wb-tool="' + id + '"]') : null);
                var rta = deps.runToolkitAction || root.runToolkitAction;
                if (typeof rta === "function") {
                    rta(row.action, row.mode, el || null, null);
                }
                return { ok: true, row: row };
            }

            if (row.run === "control") {
                var cEl = q('[data-wb-tool="' + id + '"]') || (d && d.querySelector ? d.querySelector('[data-wb-tool="' + id + '"]') : null);
                if (!cEl) {
                    var st = deps.showToast || root.showToast;
                    if (typeof st === "function") {
                        st("\u2715 " + row.title + " needs the Workbench, which couldn't load. Reload the panel to try again.", "error");
                    }
                    return { ok: false, code: "control-missing" };
                }
                if (row.id === "bounce-settings") {
                    if (typeof cEl.click === "function") cEl.click();
                    return { ok: true, row: row };
                }
                var resolve = deps.resolveToolkitMode || root.resolveToolkitMode;
                var mode = typeof resolve === "function" ? resolve(cEl) : (cEl.getAttribute("data-mode") || row.mode || "");
                if (mode && typeof mode === "object" && mode.invalid) {
                    return { ok: false, code: "composer-refused", mode: mode };
                }
                var rtaC = deps.runToolkitAction || root.runToolkitAction;
                if (typeof rtaC === "function") {
                    rtaC(row.action, typeof mode === "string" ? mode : row.mode, cEl, null);
                }
                return { ok: true, row: row };
            }

            if (row.run === "open") {
                var router = deps.router || root.CompSaverRouter;
                if (row.tab) {
                    if (router && typeof router.go === "function") {
                        router.go("tools", { source: options.source || "tool" });
                    }
                    select(row.tab, { focus: false });
                }
                var targetEl = null;
                if (row.id === "text-preset-browser") {
                    var list = q("#cs-wb-preset-list") || q('[data-wb-tool="text-preset-browser"]') || (d && d.getElementById("cs-wb-preset-list"));
                    if (list) {
                        targetEl = list.querySelector("button") || list;
                    }
                } else if (row.id === "split-text") {
                    var splitGroup = q('[data-wb-group="split-mode"]') || (d && d.querySelector('[data-wb-group="split-mode"]'));
                    if (splitGroup) {
                        targetEl = splitGroup.querySelector('[aria-checked="true"]') || splitGroup.querySelector('[role="radio"]');
                    }
                } else if (row.focus) {
                    targetEl = (d && d.getElementById(row.focus)) || q("#" + row.focus) || q('[name="' + row.focus + '"]');
                }
                if (targetEl && typeof targetEl.focus === "function") {
                    targetEl.focus();
                }
                return { ok: true, row: row };
            }

            return { ok: false, code: "invalid-run-kind" };
        }

        function init(r, options) {
            if (options) configure(options);
            rootEl = r || rootEl;
            if (!rootEl) return api;
            if (!bound) {
                bound = true;
                var tabs = qa('[role="tab"][data-wb-tab]');
                for (var i = 0; i < tabs.length; i++) {
                    (function (b) {
                        b.addEventListener("click", function () { select(b.getAttribute("data-wb-tab"), { focus: false }); });
                        b.addEventListener("keydown", function (e) {
                            if (e.key === "ArrowRight") { e.preventDefault(); select(nextTab(active, 1), { focus: true }); }
                            else if (e.key === "ArrowLeft") { e.preventDefault(); select(nextTab(active, -1), { focus: true }); }
                        });
                    })(tabs[i]);
                }
                var groups = qa(".cs-wb-seg");
                for (var g = 0; g < groups.length; g++) bindGroup(groups[g]);

                var ta = deps.TextAnim || root.TextAnim;
                if (ta && typeof ta.onPresetsChanged === "function") {
                    if (typeof unsubscribePresets === "function") unsubscribePresets();
                    unsubscribePresets = ta.onPresetsChanged(function () {
                        renderPresets();
                    });
                }
            }
            apply(active, false);
            renderPresets();
            return api;
        }

        function configure(options) {
            options = options || {};
            var keys = ["onTabChange", "doc", "focus", "router", "runToolkitAction", "resolveToolkitMode", "showToast", "bindToolkitActionControls", "TextAnim"];
            for (var i = 0; i < keys.length; i++) {
                if (Object.prototype.hasOwnProperty.call(options, keys[i])) deps[keys[i]] = options[keys[i]];
            }
            return api;
        }

        var api = {
            TABS: TABS,
            LABELS: LABELS,
            TOOL_INDEX: TOOL_INDEX,
            normalizeTab: normalizeTab,
            nextTab: nextTab,
            normalizeInt: normalizeInt,
            init: init,
            configure: configure,
            select: select,
            restore: restore,
            getActiveTab: function () { return active; },
            getRestorationPatch: function () { return { subsection: active }; },
            optionValue: optionValue,
            setOption: setOption,
            bindGroup: bindGroup,
            runTool: runTool,
            renderPresets: renderPresets
        };
        return api;
    }

    var CompSaverWorkbench = createWorkbench();
    CompSaverWorkbench.create = createWorkbench;
    CompSaverWorkbench.TOOL_INDEX = TOOL_INDEX;
    root.CompSaverWorkbench = CompSaverWorkbench;
    if (typeof module !== "undefined" && module.exports) module.exports = CompSaverWorkbench;
})(typeof window !== "undefined" ? window : globalThis);
