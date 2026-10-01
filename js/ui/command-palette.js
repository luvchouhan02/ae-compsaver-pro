// ============================================================
// ui/command-palette.js — CompSaver v2.0 Command Palette (Ctrl+K)
// ------------------------------------------------------------
// Universal quick-action search overlay: searches across templates,
// toolkit actions, FX presets, flow graph, settings, and navigation.
// Zero external dependencies. CEP-compatible.
// ============================================================

var CommandPalette = (function () {
    'use strict';

    var _isOpen = false;
    var _selectedIndex = 0;
    var _filteredItems = [];
    var _commands = [];
    var _initialized = false;
    var _trigger = null;

    // All registered commands with icon, title, category, and action
    var COMMANDS = [
        // Navigation & Views
        { id: "nav-templates", title: "Templates Library", category: "NAV", icon: "grid", run: function () { switchMainModule(MODULES.TEMPLATES); } },
        { id: "nav-comp", title: "Compositions Section", category: "TEMPLATES", icon: "box", run: function () { switchMainModule(MODULES.TEMPLATES); switchSection(SECTIONS.COMP); } },
        { id: "nav-icons", title: "Icons & Badges Section", category: "TEMPLATES", icon: "image", run: function () { switchMainModule(MODULES.TEMPLATES); switchSection(SECTIONS.ICON); } },
        { id: "nav-overlays", title: "Overlays & Backgrounds", category: "TEMPLATES", icon: "layers", run: function () { switchMainModule(MODULES.TEMPLATES); switchSection(SECTIONS.OVERLAY); } },
        { id: "nav-transitions", title: "Transitions Section", category: "TEMPLATES", icon: "shuffle", run: function () { switchMainModule(MODULES.TEMPLATES); switchSection(SECTIONS.LAYER); } },
        { id: "nav-text", title: "Text Templates Section", category: "TEMPLATES", icon: "type", run: function () { switchMainModule(MODULES.TEMPLATES); switchSection(SECTIONS.TEXT); } },
        { id: "nav-footage", title: "Footage Library Section", category: "TEMPLATES", icon: "film", run: function () { switchMainModule(MODULES.TEMPLATES); switchSection(SECTIONS.FOOTAGE); } },
        { id: "nav-effects", title: "Effect Templates Section", category: "TEMPLATES", icon: "zap", run: function () { switchMainModule(MODULES.TEMPLATES); switchSection(SECTIONS.EFFECT); } },

        // Template Operations
        { id: "tmpl-save", title: "Save New Template (Ctrl+S)", category: "TEMPLATES", icon: "plus", run: function () { openSaveModal(); } },
        { id: "tmpl-browse", title: "Change Library Folder", category: "TEMPLATES", icon: "folder", run: function () { browseCustomLibrary(); } },
        { id: "tmpl-refresh", title: "Refresh Templates", category: "TEMPLATES", icon: "refresh", run: function () { loadTemplates(); } },

        // Kit / Tools
        { id: "kit-tools", title: "Toolkit Workbench (Kit)", category: "KIT", icon: "tool", run: function () { switchMainModule(MODULES.TOOLKIT); switchToolkitSubSection("tools"); } },
        { id: "kit-ap-center", title: "Anchor Point: Center", category: "KIT", icon: "target", run: function () { runToolkitAction("anchor", "center"); } },
        { id: "kit-ap-topleft", title: "Anchor Point: Top Left", category: "KIT", icon: "target", run: function () { runToolkitAction("anchor", "top_left"); } },
        { id: "kit-ap-bottomright", title: "Anchor Point: Bottom Right", category: "KIT", icon: "target", run: function () { runToolkitAction("anchor", "bottom_right"); } },
        { id: "kit-align-center", title: "Align Layers: Center", category: "KIT", icon: "align", run: function () { runToolkitAction("align", "center_both"); } },
        { id: "kit-null", title: "Create Null Object", category: "KIT", icon: "circle", run: function () { runToolkitAction("create", "null"); } },
        { id: "kit-adj", title: "Create Adjustment Layer", category: "KIT", icon: "sliders", run: function () { runToolkitAction("create", "adjustment"); } },
        { id: "kit-solid", title: "Create Solid Layer", category: "KIT", icon: "square", run: function () { runToolkitAction("create", "solid"); } },
        { id: "kit-text", title: "Create Text Layer", category: "KIT", icon: "type", run: function () { runToolkitAction("create", "text"); } },
        { id: "kit-precomp", title: "Precompose Selected Layers", category: "KIT", icon: "package", run: function () { runToolkitAction("precompose", ""); } },
        { id: "kit-unprecomp", title: "Un-precompose Layer", category: "KIT", icon: "unlock", run: function () { runToolkitAction("unprecompose", ""); } },
        { id: "kit-truedup", title: "True Duplicate Precomp", category: "KIT", icon: "copy", run: function () { runToolkitAction("truedup", ""); } },

        // FX & Presets
        { id: "fx-presets", title: "Effects Presets Browser (FX)", category: "FX", icon: "sparkles", run: function () { switchMainModule(MODULES.TOOLKIT); switchToolkitSubSection("effects"); } },
        { id: "fx-scan", title: "Scan & Reload Effect Presets", category: "FX", icon: "refresh", run: function () { loadSavedEffects(); } },

        // Flow & Curves
        { id: "flow-graph", title: "Flow / Curve Editor", category: "FLOW", icon: "activity", run: function () { switchMainModule(MODULES.TOOLKIT); switchToolkitSubSection("graph"); } },
        { id: "flow-apply", title: "Apply Curve to Keyframes", category: "FLOW", icon: "check", run: function () { if (typeof FlowSystem !== "undefined" && FlowSystem.applyCurveToSelection) FlowSystem.applyCurveToSelection(); else showToast("Open Flow before applying a curve", "warning"); } },

        // Typography
        { id: "type-anim", title: "Text Animations Studio", category: "TYPE", icon: "type", run: function () { switchMainModule(MODULES.TOOLKIT); switchToolkitSubSection("text-anim"); } },

        // ColorFlow
        { id: "color-workshop", title: "ColorFlow Workshop", category: "COLOR", icon: "droplet", run: function () {
            var modal = document.getElementById("flow-editor-modal");
            if (modal) {
                modal.classList.add("open");
                if (typeof FocusTrap !== "undefined") FocusTrap.activate(modal);
            } else {
                switchMainModule(MODULES.TOOLKIT);
                switchToolkitSubSection("tools");
            }
        } },

        // Settings
        { id: "set-open", title: "Preferences & Settings", category: "SETTINGS", icon: "settings", run: function () {
            _previousModule = currentMainModule;
            switchMainModule(MODULES.SETTINGS);
        } },
        { id: "set-cache", title: "Clear Preview & Disk Cache", category: "SETTINGS", icon: "trash", run: function () {
            if (typeof clearPreviewCache === "function") clearPreviewCache();
            else showToast("Preview cache controls are unavailable", "warning");
        } }
    ];

    var ICONS = {
        grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
        box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
        image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
        layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
        shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/></svg>',
        type: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
        film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/></svg>',
        zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
        plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
        folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
        refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
        tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.6 6.6a2 2 0 0 1-2.8-2.8l6.6-6.6a6 6 0 0 1 7.9-7.9l-4 3.6z"/></svg>',
        target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
        align: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="18" y1="21" x2="18" y2="3"/><line x1="6" y1="21" x2="6" y2="3"/><rect x="10" y="7" width="4" height="10" rx="1"/></svg>',
        circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/></svg>',
        sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/></svg>',
        square: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
        package: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>',
        unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>',
        copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
        sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>',
        activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"/></svg>',
        droplet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m12 2.69 5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>',
        settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
        trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
    };

    function getCommands() {
        var commands = COMMANDS.slice();
        var seen = {};
        var controls = document.querySelectorAll('#toolkit-tools-view [data-toolkit-action], #toolkit-tools-view [data-seq-mode], #btn-tk-crop-execute, #btn-bounce-apply, #btn-bounce-gear, #btn-resize-apply');
        if (controls.length) commands = commands.filter(function (command) { return command.id.indexOf("kit-") !== 0 || command.id === "kit-tools"; });
        Array.prototype.forEach.call(controls, function (control) {
            var action = control.getAttribute("data-toolkit-action") || control.id || "sequence";
            if (action === "text-preset") return;
            var mode = control.getAttribute("data-mode") || control.getAttribute("data-seq-mode") || "";
            var id = "tool:" + action + ":" + mode;
            if (seen[id]) return;
            seen[id] = true;
            var title = control.getAttribute("aria-label") || control.getAttribute("title") || control.textContent.trim() || "Crop precomp bounds";
            if (action === "anchor") title = "Anchor point: " + title;
            if (action === "split-text") title = "Split text: " + title;
            if (action === "speed-ramp") title = "Speed ramp: " + title;
            if (action === "find-replace") title = "Find and replace text";
            var panel = control.closest('[role="tabpanel"]');
            var tab = panel ? panel.id.replace("cs-wb-panel-", "") : "layout";
            commands.push({ id: id, title: title, category: tab.toUpperCase(), icon: "tool", run: function () {
                if (control.disabled) { showToast(title + " is currently unavailable", "warning"); return; }
                if (action === "find-replace" || action === "blend-mode" || action === "btn-resize-apply") {
                    if (typeof CompSaverRouter !== "undefined") CompSaverRouter.go("tools", { source: "palette" });
                    if (typeof CompSaverWorkbench !== "undefined") CompSaverWorkbench.select(tab);
                    var focusId = action === "find-replace" ? "cs-wb-find" : action === "blend-mode" ? "cs-wb-blend" : "resize-res";
                    var field = document.getElementById(focusId);
                    if (field) field.focus();
                    return;
                }
                control.click();
            } });
        });
        if (typeof TextAnim !== "undefined" && typeof TextAnim.getPresets === "function") {
            TextAnim.getPresets().forEach(function (preset) {
                commands.push({ id: "text:" + preset.path, title: preset.displayName || preset.path, category: "TEXT PRESET", icon: "type", run: function () { TextAnim.applyPreset(preset.path); } });
            });
        }
        if (typeof OneFramers !== "undefined") {
            OneFramers.getRecipes().forEach(function (recipe) {
                commands.push({ id: "oneframer:" + recipe.name, title: recipe.name, category: "ONE-FRAMER", icon: "sparkles", run: function () { OneFramers.apply(recipe.name); } });
            });
        }
        if (typeof savedEffectsCache !== "undefined" && typeof handleEffectApply === "function") {
            savedEffectsCache.forEach(function (preset) {
                if (!preset.path) return;
                commands.push({ id: "effect:" + preset.path, title: preset.name || preset.path, category: "FX PRESET", icon: "zap", run: function () {
                    var button = document.createElement("button");
                    button.dataset.effectFile = preset.path;
                    button.dataset.effectName = preset.name || preset.path;
                    handleEffectApply(button);
                } });
            });
        }
        if (typeof allTemplates !== "undefined" && typeof getTemplateSection === "function") {
            allTemplates.forEach(function (template) {
                if (!template.name) return;
                var section = getTemplateSection(template);
                var id = "template:" + (template.id || [template.sourcePath, section, template.category, template.name].join("|"));
                if (seen[id]) return;
                seen[id] = true;
                commands.push({ id: id, title: "Find template: " + template.name, category: "TEMPLATE " + (template.category || section), icon: "grid", run: function () {
                    switchMainModule(MODULES.TEMPLATES);
                    switchSection(section);
                    var search = document.getElementById("search-box");
                    if (!search) { showToast("Template search is unavailable", "warning"); return; }
                    search.value = template.name;
                    search.dispatchEvent(new Event("input", { bubbles: true }));
                    search.focus();
                } });
            });
        }
        return commands;
    }

    function renderItems() {
        var resultsEl = document.getElementById("cs-cmd-results");
        if (!resultsEl) return;
        var input = document.getElementById("cs-cmd-input");
        if (input) {
            if (_filteredItems.length) input.setAttribute("aria-activedescendant", "cs-command-option-" + _selectedIndex);
            else input.removeAttribute("aria-activedescendant");
        }

        if (_filteredItems.length === 0) {
            resultsEl.innerHTML = '<div class="cs-command-palette__empty">No matching commands</div>';
            return;
        }

        var html = "";
        for (var i = 0; i < _filteredItems.length; i++) {
            var item = _filteredItems[i];
            var isSel = (i === _selectedIndex);
            var iconSvg = ICONS[item.icon] || ICONS.zap;
            html += '<div role="option" id="cs-command-option-' + i + '" aria-selected="' + isSel + '" class="cs-command-palette__item' + (isSel ? ' active' : '') + '" data-index="' + i + '">' +
                '<div aria-hidden="true" class="cs-command-palette__item-icon">' + iconSvg + '</div>' +
                '<div class="cs-command-palette__item-text">' +
                    '<div class="cs-command-palette__item-name">' + escapeHTML(item.title) + '</div>' +
                '</div>' +
                '<span class="cs-command-palette__item-badge">' + escapeHTML(item.category) + '</span>' +
            '</div>';
        }
        resultsEl.innerHTML = html;

        var activeEl = resultsEl.querySelector(".cs-command-palette__item.active");
        if (activeEl && typeof activeEl.scrollIntoView === "function") {
            activeEl.scrollIntoView({ block: "nearest" });
        }
    }

    function filterCommands(query) {
        query = (query || "").trim().toLowerCase();
        if (!query) {
            _filteredItems = _commands.slice(0, 15);
        } else {
            _filteredItems = [];
            for (var i = 0; i < _commands.length; i++) {
                var cmd = _commands[i];
                var searchable = (cmd.title + " " + cmd.category).toLowerCase();
                if (query.split(/\s+/).every(function (word) { return searchable.indexOf(word) !== -1; })) {
                    _filteredItems.push(cmd);
                }
            }
        }
        _selectedIndex = 0;
        renderItems();
    }

    function executeSelected() {
        if (_filteredItems.length === 0 || !_filteredItems[_selectedIndex]) return;
        var cmd = _filteredItems[_selectedIndex];
        close();
        try {
            cmd.run();
        } catch (e) {
            console.error("[CommandPalette] Action error:", e);
            if (typeof showToast === "function") showToast("Couldn't run " + cmd.title + ". " + (e.message || e), "error");
        }
    }

    function open() {
        var el = document.getElementById("cs-command-palette");
        var input = document.getElementById("cs-cmd-input");
        if (!el || !input) return;
        if (_isOpen) { input.focus(); return; }
        _trigger = document.activeElement;
        if (typeof CompSaverViews !== "undefined") CompSaverViews.ensureMounted("tools");
        _commands = getCommands();

        _isOpen = true;
        el.classList.add("open");
        input.setAttribute("aria-expanded", "true");
        input.value = "";
        filterCommands("");
        if (typeof FocusTrap !== "undefined") FocusTrap.activate(el, _trigger);
        input.focus();
        if (typeof OneFramers !== "undefined") {
            OneFramers.load().then(function () {
                if (_isOpen) { _commands = getCommands(); filterCommands(input.value); }
            }).catch(function (error) { if (typeof showToast === "function") showToast(error.message, "error"); });
        }
    }

    function close() {
        var el = document.getElementById("cs-command-palette");
        if (!el) return;
        _isOpen = false;
        el.classList.remove("open");
        var input = document.getElementById("cs-cmd-input");
        if (input) input.setAttribute("aria-expanded", "false");
        if (typeof FocusTrap !== "undefined" && FocusTrap.getActive() === el) FocusTrap.deactivate();
        else if (_trigger && typeof _trigger.focus === "function") _trigger.focus();
        _trigger = null;
    }

    function init() {
        var overlay = document.getElementById("cs-command-palette");
        var input = document.getElementById("cs-cmd-input");
        var results = document.getElementById("cs-cmd-results");
        if (_initialized || !overlay || !input || !results) return;
        _initialized = true;

        if (input) {
            input.addEventListener("input", function () {
                filterCommands(this.value);
            });

            input.addEventListener("keydown", function (e) {
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    if (_filteredItems.length > 0) {
                        _selectedIndex = (_selectedIndex + 1) % _filteredItems.length;
                        renderItems();
                    }
                } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    if (_filteredItems.length > 0) {
                        _selectedIndex = (_selectedIndex - 1 + _filteredItems.length) % _filteredItems.length;
                        renderItems();
                    }
                } else if (e.key === "Enter") {
                    e.preventDefault();
                    executeSelected();
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    close();
                }
            });
        }

        if (results) {
            results.addEventListener("click", function (e) {
                var itemEl = e.target.closest(".cs-command-palette__item");
                if (itemEl) {
                    var idx = parseInt(itemEl.dataset.index, 10);
                    if (!isNaN(idx) && _filteredItems[idx]) {
                        _selectedIndex = idx;
                        executeSelected();
                    }
                }
            });
        }

        if (overlay) {
            overlay.addEventListener("click", function (e) {
                if (e.target === overlay) close();
            });
        }

        // Global hotkey Ctrl+K / Cmd+K
        document.addEventListener("keydown", function (e) {
            if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
                e.preventDefault();
                if (_isOpen) close();
                else open();
            }
        });
    }

    return {
        init: init,
        open: open,
        close: close,
        getCommands: getCommands,
        isOpen: function () { return _isOpen; }
    };
})();
