// ============================================================
// ui/settings-panel.js — Settings Panel UI (accordion-based)
// ------------------------------------------------------------
// Global SettingsPanel IIFE: renders collapsible accordion sections
// with controls (toggles, dropdowns, sliders, inputs, buttons).
// Depends on globals: Settings, showToast, csInterface,
// switchMainModule, currentMainModule, MODULES.
// main.js calls SettingsPanel.init(); header.js calls open()/close().
// Loaded after settings.js and header.js, before main.js.
// ============================================================

var SettingsPanel = (function () {

    // ── Private State ──────────────────────────────────────────────
    var _container = null;
    var _isOpen = false;
    var _documentClickBound = false;

    /** Main module active when Settings was opened (Back returns there). */
    var _returnModule = null;

    /** Re-entrancy guard for the batched preview-cache clear. */
    var _cacheClearing = false;

    // ── SVG Icons (inline for zero-dependency rendering) ──────────
    var ICONS = {
        back: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>',
        chevron: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
        folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
        film: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
        layout: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>',
        zap: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
        tool: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
        download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        info: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
        reset: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
        browse: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
        selectArrow: '<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
        external: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'
    };

    // ── Section Definitions ────────────────────────────────────────
    var SECTION_DEFS = [
        {
            id: "library",
            title: "Library & Storage",
            icon: "folder",
            controls: [
                { key: "_library.currentPath", label: "Library path", desc: "All assets are stored here", type: "libraryPath" },
                {
                    key: "library.saveTo", label: "Save location", desc: "Where new templates are saved", type: "dropdown", options: [
                        { value: "default", label: "Default" },
                        { value: "custom", label: "Custom" },
                        { value: "ask", label: "Ask" }
                    ]
                },
                { key: "library.confirmOverwrite", label: "Confirm before overwrite", desc: "Ask before replacing existing presets", type: "toggle" }
            ]
        },
        {
            id: "preview",
            title: "Preview & Rendering",
            icon: "film",
            controls: [
                { key: "preview.autoGenerate", label: "Auto-generate preview on save", desc: "Generate animated preview after saving", type: "toggle" },
                {
                    key: "preview.quality", label: "Preview quality", type: "dropdown", options: [
                        { value: "low", label: "Low" },
                        { value: "medium", label: "Medium" },
                        { value: "high", label: "High" }
                    ]
                },
                { key: "preview.maxDuration", label: "Max preview duration", desc: "Maximum seconds for generated previews", type: "slider", min: 1, max: 30, step: 1, suffix: "s" },
                { key: "preview.showNotifications", label: "Show preview notifications", desc: "Toast notifications for render progress", type: "toggle" },
                { key: "preview.disableHover", label: "Disable hover previews", desc: "Turn off animated preview on card hover", type: "toggle" }
            ]
        },
        {
            id: "ui",
            title: "UI & Appearance",
            icon: "layout",
            controls: [
                {
                    key: "ui.defaultTab", label: "Default tab on launch", type: "dropdown", options: [
                        { value: "toolkit", label: "Toolkit" },
                        { value: "templates", label: "Templates" }
                    ]
                },
                {
                    key: "ui.defaultSection", label: "Default section", type: "dropdown", options: [
                        { value: "comp", label: "Comp" },
                        { value: "icon", label: "Icon" },
                        { value: "overlay", label: "Overlay" },
                        { value: "layer", label: "Layer" },
                        { value: "text", label: "Text" },
                        { value: "footage", label: "Footage" },
                        { value: "effect", label: "Effect" }
                    ]
                },
                {
                    key: "ui.density", label: "Panel density", desc: "Compact default or roomier expanded spacing", type: "dropdown", options: [
                        { value: "compact", label: "Compact" },
                        { value: "expanded", label: "Expanded" }
                    ]
                },
                { key: "ui.confirmDelete", label: "Confirm before delete", desc: "Show confirmation dialog on delete actions", type: "toggle" },
                { key: "ui.showAllCategoriesInline", label: "Show all categories inline", desc: "Display all category tabs without overflow menu", type: "toggle" }
            ]
        },
        {
            id: "cardSizes",
            title: "Card Sizes",
            icon: "layout",
            controls: [
                { type: "card-sizes-group" }
            ]
        },
        {
            id: "performance",
            title: "Performance",
            icon: "zap",
            controls: [
                { key: "performance.searchDebounce", label: "Search debounce", desc: "Delay before search fires (ms)", type: "slider", min: 50, max: 500, step: 10, suffix: "ms" },
                { key: "performance.liveFolderWatch", label: "Live folder watch", desc: "Auto-detect changes in library folders", type: "toggle" },
                { key: "performance.pingInterval", label: "Ping interval", desc: "AE connection check frequency (seconds)", type: "slider", min: 5, max: 120, step: 5, suffix: "s" }
            ]
        },
        {
            id: "toolkit",
            title: "Toolkit Defaults",
            icon: "tool",
            controls: [
                { key: "toolkit.quietRapidTools", label: "Quiet rapid tools", desc: "No success toast for anchor, align, sequence, guides and expression removal", type: "toggle" },
                { key: "toolkit.sequencerStep", label: "Sequencer step", desc: "Default frame offset between layers", type: "slider", min: 1, max: 100, step: 1, suffix: "" },
                {
                    key: "toolkit.sequencerMode", label: "Sequencer mode", type: "dropdown", options: [
                        { value: "down", label: "Down" },
                        { value: "up", label: "Up" },
                        { value: "random", label: "Random" },
                        { value: "from_center", label: "From Center" },
                        { value: "to_center", label: "To Center" }
                    ]
                },
                {
                    key: "toolkit.colorflowTarget", label: "ColorFlow default target", type: "dropdown", options: [
                        { value: "fill", label: "Fill" },
                        { value: "stroke", label: "Stroke" },
                        { value: "both", label: "Both" }
                    ]
                }
            ]
        },
        {
            id: "backup",
            title: "Backup & Data",
            icon: "download",
            controls: [] // Rendered with special action buttons
        },
        {
            id: "about",
            title: "About",
            icon: "info",
            controls: [] // Rendered with version + links
        }
    ];

    // ── Render Helpers ───────────────────────────────────────────

    function _renderHeader() {
        return '<div class="settings-header">' +
            '<button class="settings-back-btn" id="settings-back-btn" type="button" title="Back">' +
            ICONS.back +
            '</button>' +
            '<span class="settings-title">Settings</span>' +
            '</div>';
    }

    function _renderToggle(ctrl, value) {
        var checked = value ? ' checked' : '';
        return '<div class="settings-row" data-key="' + ctrl.key + '">' +
            '<div class="settings-row-info">' +
            '<span class="settings-row-label">' + ctrl.label + '</span>' +
            (ctrl.desc ? '<span class="settings-row-desc">' + ctrl.desc + '</span>' : '') +
            '</div>' +
            // Toggle-switch control pattern: track → thumb (base.css .cs-switch).
            // Pattern classes are added alongside the existing settings-* classes;
            // the input + its data-key and the checked-state selectors are unchanged.
            '<label class="cs-switch settings-toggle">' +
            '<input type="checkbox"' + checked + ' data-key="' + ctrl.key + '" aria-label="' + _escapeAttr(ctrl.label) + '">' +
            '<span class="cs-switch__track settings-toggle-track"></span>' +
            '<span class="cs-switch__thumb settings-toggle-thumb"></span>' +
            '</label>' +
            '</div>';
    }

    function _renderDropdown(ctrl, value) {
        var displayLabel = '';
        for (var i = 0; i < ctrl.options.length; i++) {
            if (ctrl.options[i].value === value) {
                displayLabel = ctrl.options[i].label;
                break;
            }
        }
        if (!displayLabel && ctrl.options.length) displayLabel = ctrl.options[0].label;

        var optionsHtml = '';
        for (var j = 0; j < ctrl.options.length; j++) {
            var opt = ctrl.options[j];
            var active = opt.value === value ? ' active' : '';
            optionsHtml += '<button type="button" class="settings-select-option' + active + '" data-value="' + opt.value + '">' + opt.label + '</button>';
        }

        return '<div class="settings-row" data-key="' + ctrl.key + '">' +
            '<div class="settings-row-info">' +
            '<span class="settings-row-label">' + ctrl.label + '</span>' +
            (ctrl.desc ? '<span class="settings-row-desc">' + ctrl.desc + '</span>' : '') +
            '</div>' +
            '<div class="settings-select" data-key="' + ctrl.key + '">' +
            '<button type="button" class="settings-select-trigger" aria-label="' + _escapeAttr(ctrl.label) + '" aria-expanded="false">' +
            '<span class="settings-select-value">' + displayLabel + '</span>' +
            '<span class="settings-select-arrow">' + ICONS.selectArrow + '</span>' +
            '</button>' +
            '<div class="settings-select-options">' + optionsHtml + '</div>' +
            '</div>' +
            '</div>';
    }

    function _renderMiniDropdown(config) {
        var value = Settings.get(config.key);
        var displayLabel = '';
        for (var i = 0; i < config.options.length; i++) {
            if (config.options[i].value === value) {
                displayLabel = config.options[i].label;
                break;
            }
        }
        if (!displayLabel && config.options.length) displayLabel = config.options[0].label;

        var optionsHtml = '';
        for (var j = 0; j < config.options.length; j++) {
            var opt = config.options[j];
            var active = opt.value === value ? ' active' : '';
            optionsHtml += '<button type="button" class="settings-select-option' + active + '" data-value="' + opt.value + '">' + opt.label + '</button>';
        }

        return '<div class="card-size-col" style="display:flex; flex-direction:column; gap:var(--space-3, 6px);">' +
            '<div class="settings-row-info" style="margin:0;">' +
            '<span class="settings-row-label">' + config.title + '</span>' +
            (config.subtitle ? '<span class="settings-row-desc">' + config.subtitle + '</span>' : '') +
            '</div>' +
            '<div class="settings-select" data-key="' + config.key + '" style="margin:0; width:100%;">' +
            '<button type="button" class="settings-select-trigger" aria-label="' + config.title + ' card size" aria-expanded="false">' +
            '<span class="settings-select-value">' + displayLabel + '</span>' +
            '<span class="settings-select-arrow">' + ICONS.selectArrow + '</span>' +
            '</button>' +
            '<div class="settings-select-options">' + optionsHtml + '</div>' +
            '</div>' +
            '</div>';
    }

    function _renderCardSizesGroup() {
        var html = '<div class="settings-row" style="border-bottom:none; padding-top:var(--space-2, 4px); padding-bottom:var(--space-1, 2px); align-items:flex-start;">' +
            '<div class="card-sizes-grid" style="width:100%; display:grid; grid-template-columns: repeat(auto-fit, minmax(105px, 1fr)); gap: var(--space-4, 8px);">';

        var sizeOptions = [
            { value: "small", label: "Small" },
            { value: "medium", label: "Medium" },
            { value: "large", label: "Large" }
        ];

        html += _renderMiniDropdown({
            key: "ui.templateCardSize",
            title: "Templates",
            subtitle: "Comp, Layer, Text, Footage, Effect",
            options: sizeOptions
        });

        html += _renderMiniDropdown({
            key: "ui.textAnimCardSize",
            title: "Text &amp; Image",
            subtitle: "Toolkit &gt; Type, Templates &gt; Image",
            options: sizeOptions
        });

        html += _renderMiniDropdown({
            key: "ui.iconCardSize",
            title: "Icon",
            subtitle: "Toolkit &gt; Icon",
            options: sizeOptions
        });

        html += '</div></div>';
        return html;
    }

    function _renderSlider(ctrl, value) {
        var displayVal = value + (ctrl.suffix || '');
        return '<div class="settings-row" data-key="' + ctrl.key + '">' +
            '<div class="settings-row-info">' +
            '<span class="settings-row-label">' + ctrl.label + '</span>' +
            (ctrl.desc ? '<span class="settings-row-desc">' + ctrl.desc + '</span>' : '') +
            '</div>' +
            '<div class="settings-slider">' +
            '<input type="range" aria-label="' + _escapeAttr(ctrl.label) + '" min="' + ctrl.min + '" max="' + ctrl.max + '" step="' + ctrl.step + '" value="' + value + '" data-key="' + ctrl.key + '" data-suffix="' + (ctrl.suffix || '') + '">' +
            '<span class="settings-slider-value">' + displayVal + '</span>' +
            '</div>' +
            '</div>';
    }

    function _renderTextInput(ctrl, value) {
        return '<div class="settings-row" data-key="' + ctrl.key + '">' +
            '<div class="settings-row-info">' +
            '<span class="settings-row-label">' + ctrl.label + '</span>' +
            (ctrl.desc ? '<span class="settings-row-desc">' + ctrl.desc + '</span>' : '') +
            '</div>' +
            '<div class="settings-input">' +
            '<input type="text" aria-label="' + _escapeAttr(ctrl.label) + '" value="' + _escapeAttr(value || '') + '" data-key="' + ctrl.key + '" placeholder="Enter path...">' +
            '<button class="settings-input-browse" type="button" data-key="' + ctrl.key + '" title="Browse">' + ICONS.browse + '</button>' +
            '</div>' +
            '</div>';
    }

    function _renderControl(ctrl) {
        var value = Settings.get(ctrl.key);
        switch (ctrl.type) {
            case "toggle": return _renderToggle(ctrl, value);
            case "dropdown": return _renderDropdown(ctrl, value);
            case "card-sizes-group": return _renderCardSizesGroup();
            case "slider": return _renderSlider(ctrl, value);
            case "text": return _renderTextInput(ctrl, value);
            case "accent": return _renderAccent(ctrl, value);
            case "libraryPath": return _renderLibraryPath(ctrl);
            default: return '';
        }
    }

    function _renderAccent(ctrl, value) {
        // Preset swatches + a custom color picker. The swatch fill is a literal
        // color CHOICE (like the ColorFlow swatches), set inline — not a token.
        // The active ring / surfaces use design tokens via the stylesheet.
        var presets = (typeof Accent !== "undefined" && Accent.PRESET_ORDER) ? Accent.PRESET_ORDER : [];
        var customHex = Settings.get("appearance.accentCustom") || "#7c3aed";
        var swatches = '';
        for (var i = 0; i < presets.length; i++) {
            var p = presets[i];
            var hex = (Accent.PRESETS && Accent.PRESETS[p.id]) || "#4f8cff";
            var active = value === p.id ? ' active' : '';
            swatches += '<button type="button" class="settings-accent-swatch' + active + '" ' +
                'data-accent="' + p.id + '" title="' + p.label + '" aria-label="' + p.label + ' accent" ' +
                'style="background:' + hex + ';"></button>';
        }
        var customActive = value === "custom" ? ' active' : '';
        return '<div class="settings-row settings-row--accent" data-key="' + ctrl.key + '">' +
            '<div class="settings-row-info">' +
            '<span class="settings-row-label">' + ctrl.label + '</span>' +
            (ctrl.desc ? '<span class="settings-row-desc">' + ctrl.desc + '</span>' : '') +
            '</div>' +
            '<div class="settings-accent" data-key="' + ctrl.key + '">' +
            '<div class="settings-accent-swatches">' +
            swatches +
            '<button type="button" class="settings-accent-swatch settings-accent-swatch--custom' + customActive + '" ' +
            'id="settings-accent-custom-btn" data-accent="custom" title="Custom color" ' +
            'aria-haspopup="dialog" aria-label="Custom color"></button>' +
            '</div>' +
            '</div>' +
            '</div>';
    }

    function _renderLibraryPath(ctrl) {
        var currentPath = (typeof rootPath !== "undefined" && rootPath) ? rootPath : "Not connected";
        var shortPath = currentPath.length > 35 ? "..." + currentPath.slice(-32) : currentPath;
        return '<div class="settings-row" data-key="' + ctrl.key + '" style="flex-wrap:wrap;">' +
            '<div class="settings-row-info" style="flex-basis:100%;">' +
            '<span class="settings-row-label">' + ctrl.label + '</span>' +
            (ctrl.desc ? '<span class="settings-row-desc">' + ctrl.desc + '</span>' : '') +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:6px;width:100%;margin-top:4px;">' +
            '<span class="settings-library-path" title="' + _escapeAttr(currentPath) + '" style="flex:1;font-family:var(--font-mono);font-size:8px;color:var(--ink-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + shortPath + '</span>' +
            '<button class="settings-action-btn" id="btn-settings-browse-library" type="button" style="flex-shrink:0;height:22px;padding:0 8px;">' +
            ICONS.browse + ' Browse' +
            '</button>' +
            '</div>' +
            '</div>';
    }

    function _renderResetButton(sectionId) {
        return '<button class="settings-reset-btn" data-reset-section="' + sectionId + '" type="button">' +
            ICONS.reset + ' Reset to default' +
            '</button>';
    }

    function _renderBackupSection() {
        return '<div class="settings-section-content">' +
            '<div class="settings-actions-group">' +
            '<button class="settings-action-btn" id="btn-settings-export" type="button">' +
            ICONS.download + ' Export Settings' +
            '</button>' +
            '<button class="settings-action-btn" id="btn-settings-import" type="button">' +
            ICONS.download + ' Import Settings' +
            '</button>' +
            '<button class="settings-action-btn settings-action-btn--danger" id="btn-settings-reset-all" type="button">' +
            ICONS.reset + ' Reset All Settings' +
            '</button>' +
            '<button class="settings-action-btn" id="btn-settings-clear-cache" type="button">' +
            ICONS.reset + ' Clear Preview Cache' +
            '</button>' +
            '</div>' +
            '</div>';
    }

    function _getVersion() {
        try {
            if (typeof csInterface !== "undefined" && csInterface.getExtensions) {
                var exts = csInterface.getExtensions(["com.lab.motion.panel"]);
                if (exts && exts.length > 0 && exts[0].version) {
                    return exts[0].version;
                }
            }
        } catch (e) { /* fallback */ }
        return "1.0.0";
    }

    function _renderAboutSection() {
        var version = _getVersion();
        return '<div class="settings-section-content">' +
            '<div class="settings-about-info">' +
            '<span class="settings-about-version">Version ' + version + '</span>' +
            '<div class="settings-about-links">' +
            '<a class="settings-link" data-url="https://labpro.motion" href="#">' +
            ICONS.external + ' Website' +
            '</a>' +
            '<a class="settings-link" data-url="https://labpro.motion/support" href="#">' +
            ICONS.external + ' Support' +
            '</a>' +
            '<a class="settings-link" data-url="https://labpro.motion/report-bug" href="#">' +
            ICONS.external + ' Report Bug' +
            '</a>' +
            '</div>' +
            '</div>' +
            '</div>';
    }

    function _renderSection(def, index) {
        var expanded = '';
        var bodyContent = '';

        if (def.id === "backup") {
            bodyContent = _renderBackupSection();
        } else if (def.id === "about") {
            bodyContent = _renderAboutSection();
        } else {
            var controlsHtml = '';
            for (var i = 0; i < def.controls.length; i++) {
                controlsHtml += _renderControl(def.controls[i]);
            }
            bodyContent = '<div class="settings-section-content">' +
                controlsHtml +
                _renderResetButton(def.id) +
                '</div>';
        }

        return '<div class="cs-accordion settings-section' + expanded + '" data-section="' + def.id + '">' +
            '<button type="button" class="cs-accordion__header settings-section-header" aria-expanded="false" aria-controls="settings-body-' + def.id + '">' +
            '<span class="cs-accordion__label settings-section-label">' +
            '<span class="settings-section-icon">' + ICONS[def.icon] + '</span>' +
            '<span class="settings-section-title">' + def.title + '</span>' +
            '</span>' +
            '<span class="cs-accordion__chevron settings-section-chevron">' + ICONS.chevron + '</span>' +
            '</button>' +
            '<div class="cs-accordion__body settings-section-body" id="settings-body-' + def.id + '">' +
            bodyContent +
            '</div>' +
            '</div>';
    }

    function _renderAll() {
        var html = _renderHeader();
        html += '<div class="settings-scroll">';
        html += '<div class="settings-inner">';

        // Render Accent Theme globally at the top
        var accentCtrl = { key: "appearance.accent", label: "Accent Theme", type: "accent" };
        var accentValue = Settings.get(accentCtrl.key);

        // Wrap in a stylized container to match the UI aesthetic requested
        html += '<div class="settings-global-accent" style="margin-bottom: var(--space-4, 8px); padding: var(--space-4, 8px) 0;">';
        html += _renderAccent(accentCtrl, accentValue);
        html += '</div>';

        // Divider
        html += '<div class="settings-global-divider" style="height: 1px; background: var(--p-rule); margin: 0 0 var(--space-4, 8px) 0;"></div>';

        for (var i = 0; i < SECTION_DEFS.length; i++) {
            html += _renderSection(SECTION_DEFS[i], i);
        }
        html += '</div>';
        html += '</div>';
        return html;
    }

    // ── Utility ────────────────────────────────────────────────────

    function _escapeAttr(str) {
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── Event Binding ──────────────────────────────────────────────

    function _bindEvents() {
        if (!_container) return;

        // ── Back button ────────────────────────────────────────────
        var backBtn = document.getElementById("settings-back-btn");
        if (backBtn) {
            backBtn.addEventListener("click", function () {
                // Route mounts: go back through the router so Shell_State and
                // the visible mount stay in step (the old call is the fallback).
                if (typeof CompSaverRouter !== "undefined" && CompSaverRouter && typeof CompSaverRouter.back === "function") {
                    CompSaverRouter.back();
                    return;
                }
                if (typeof switchMainModule !== "function") return;
                // Return to the module recorded at open time (setReturnModule);
                // fall back to Templates when Settings was opened another way.
                if (_returnModule) {
                    switchMainModule(_returnModule);
                } else {
                    switchMainModule(typeof MODULES !== "undefined" ? MODULES.TEMPLATES : "templates");
                }
            });
        }

        // ── Accordion expand/collapse ──────────────────────────────
        var headers = _container.querySelectorAll(".settings-section-header");
        for (var h = 0; h < headers.length; h++) {
            headers[h].addEventListener("click", function () {
                var section = this.parentElement;
                if (section) {
                    section.classList.toggle("expanded");
                    this.setAttribute("aria-expanded", String(section.classList.contains("expanded")));
                }
            });
        }

        // ── Toggle switches ────────────────────────────────────────
        var toggles = _container.querySelectorAll('.settings-toggle input[type="checkbox"]');
        for (var t = 0; t < toggles.length; t++) {
            toggles[t].addEventListener("change", function () {
                var key = this.getAttribute("data-key");
                if (key) Settings.set(key, this.checked);
            });
        }

        // ── Custom dropdowns ───────────────────────────────────────
        var selectTriggers = _container.querySelectorAll(".settings-select-trigger");
        for (var s = 0; s < selectTriggers.length; s++) {
            selectTriggers[s].addEventListener("click", function (e) {
                e.stopPropagation();
                var parent = this.parentElement;
                var isOpen = parent.classList.contains("open");
                // Close all other open dropdowns
                var allSelects = _container.querySelectorAll(".settings-select.open");
                for (var a = 0; a < allSelects.length; a++) {
                    allSelects[a].classList.remove("open");
                    allSelects[a].querySelector(".settings-select-trigger").setAttribute("aria-expanded", "false");
                }
                if (!isOpen) parent.classList.add("open");
                this.setAttribute("aria-expanded", String(!isOpen));
            });
            selectTriggers[s].parentElement.addEventListener("keydown", function (event) {
                if (event.key === "Escape") {
                    event.preventDefault();
                    this.classList.remove("open");
                    var trigger = this.querySelector(".settings-select-trigger");
                    trigger.setAttribute("aria-expanded", "false");
                    trigger.focus();
                }
            });
        }

        var selectOptions = _container.querySelectorAll(".settings-select-option");
        for (var o = 0; o < selectOptions.length; o++) {
            selectOptions[o].addEventListener("click", function (e) {
                e.stopPropagation();
                var value = this.getAttribute("data-value");
                var selectEl = this.closest(".settings-select");
                var key = selectEl ? selectEl.getAttribute("data-key") : null;
                if (key && value !== null) {
                    Settings.set(key, value);
                    // Update display
                    var valueSpan = selectEl.querySelector(".settings-select-value");
                    if (valueSpan) valueSpan.textContent = this.textContent;
                    // Update active state
                    var siblings = selectEl.querySelectorAll(".settings-select-option");
                    for (var si = 0; si < siblings.length; si++) siblings[si].classList.remove("active");
                    this.classList.add("active");
                }
                if (selectEl) {
                    selectEl.classList.remove("open");
                    var trigger = selectEl.querySelector(".settings-select-trigger");
                    trigger.setAttribute("aria-expanded", "false");
                    trigger.focus();
                }
            });
        }

        // ── Accent color swatches + custom picker ──────────────────
        function _markAccentActive(target, group) {
            if (group) {
                var all = group.querySelectorAll(".settings-accent-swatch");
                for (var s2 = 0; s2 < all.length; s2++) all[s2].classList.remove("active");
            }
            if (target) target.classList.add("active");
        }

        var accentSwatches = _container.querySelectorAll(".settings-accent-swatch[data-accent]");
        for (var ac = 0; ac < accentSwatches.length; ac++) {
            accentSwatches[ac].addEventListener("click", function (e) {
                var val = this.getAttribute("data-accent");
                if (!val) return;
                var group = this.closest(".settings-accent-swatches");
                if (val === "custom") {
                    // Open the custom Adobe/Figma-style picker popover (NOT the
                    // native OS color dialog). Commit happens on Apply, which
                    // routes through the unchanged Accent Theme Settings path.
                    e.preventDefault();
                    var self = this;
                    if (typeof AccentPicker !== "undefined" && AccentPicker.open) {
                        AccentPicker.open(this, {
                            initialHex: Settings.get("appearance.accentCustom") || "#7c3aed",
                            onPreview: function (hex) {
                                if (typeof Accent !== "undefined" && Accent.apply) {
                                    Accent.apply("custom", hex);
                                }
                            },
                            onRevert: function () {
                                if (typeof Accent !== "undefined" && Accent.apply) {
                                    var origPreset = Settings.get("appearance.accent") || "blue";
                                    var origCustom = Settings.get("appearance.accentCustom") || "#7c3aed";
                                    Accent.apply(origPreset, origCustom);
                                }
                            },
                            onApply: function (hex) {
                                Settings.set("appearance.accentCustom", hex);
                                Settings.set("appearance.accent", "custom");
                                _markAccentActive(self, group);
                            }
                        });
                    }
                    return;
                }
                e.preventDefault();
                Settings.set("appearance.accent", val);
                _markAccentActive(this, group);
            });
        }

        // ── Range sliders ──────────────────────────────────────────
        var sliders = _container.querySelectorAll('.settings-slider input[type="range"]');
        for (var sl = 0; sl < sliders.length; sl++) {
            sliders[sl].addEventListener("input", function () {
                var key = this.getAttribute("data-key");
                var suffix = this.getAttribute("data-suffix") || "";
                var valSpan = this.parentElement.querySelector(".settings-slider-value");
                if (valSpan) valSpan.textContent = this.value + suffix;
            });
            sliders[sl].addEventListener("change", function () {
                var key = this.getAttribute("data-key");
                if (key) Settings.set(key, Number(this.value));
            });
        }

        // ── Text inputs ────────────────────────────────────────────
        var textInputs = _container.querySelectorAll('.settings-input input[type="text"]');
        for (var ti = 0; ti < textInputs.length; ti++) {
            textInputs[ti].addEventListener("change", function () {
                var key = this.getAttribute("data-key");
                if (key) Settings.set(key, this.value);
            });
        }

        // ── Browse buttons (text input path picker) ────────────────
        var browseButtons = _container.querySelectorAll(".settings-input-browse");
        for (var b = 0; b < browseButtons.length; b++) {
            browseButtons[b].addEventListener("click", function () {
                var key = this.getAttribute("data-key");
                if (!key) return;
                csInterface.evalScript(
                    '(function(){ var f = Folder.selectDialog("Select folder"); return f ? encodeBridge(f.fsName) : ""; })()',
                    function (hexPath) {
                        if (!hexPath) return;
                        var path = decodeBridge(hexPath);
                        if (path) {
                            Settings.set(key, path.replace(/\\/g, "/"));
                            SettingsPanel.refresh();
                        }
                    }
                );
            });
        }

        // ── Reset section buttons ──────────────────────────────────
        var resetBtns = _container.querySelectorAll(".settings-reset-btn[data-reset-section]");
        for (var r = 0; r < resetBtns.length; r++) {
            resetBtns[r].addEventListener("click", function () {
                var section = this.getAttribute("data-reset-section");
                if (section) {
                    Settings.resetSection(section);
                    SettingsPanel.refresh();
                    if (typeof showToast === "function") showToast(section + " settings reset", "success");
                }
            });
        }

        // ── Browse Library Path ────────────────────────────────────
        var browseLibBtn = document.getElementById("btn-settings-browse-library");
        if (browseLibBtn) {
            browseLibBtn.addEventListener("click", function () {
                csInterface.evalScript('selectFolder()', function (hexPath) {
                    if (!hexPath) return;
                    var path = decodeBridge(hexPath).replace(/\\/g, "/");
                    if (!path) return;
                    // Update rootPath globally
                    rootPath = path;
                    if (libraryPaths.indexOf(path) === -1) {
                        libraryPaths = [path];
                    } else {
                        libraryPaths[0] = path;
                    }
                    savePath = path;
                    localStorage.setItem("compSaver_libraryPaths", JSON.stringify(libraryPaths));
                    // Ensure folder exists
                    csInterface.evalScript('ensureFolder("' + encodeBridge(path) + '")', function () {
                        // Reload everything. Forced: rootPath just changed, so
                        // the effects freshness cache must not serve the old roots.
                        loadTemplates();
                        if (typeof loadSavedEffects === "function") loadSavedEffects(true);
                        if (typeof TextAnim !== "undefined" && TextAnim.load) TextAnim.load();
                        showToast("Library path updated", "success");
                        SettingsPanel.refresh();
                    });
                });
            });
        }

        // ── Export Settings (Task 7.1) ─────────────────────────────
        var exportBtn = document.getElementById("btn-settings-export");
        if (exportBtn) {
            exportBtn.addEventListener("click", function () {
                var json = Settings.exportJSON();
                var fs = null;
                try { fs = require("fs"); } catch (e) { }
                if (!fs) { showToast("File system unavailable", "error"); return; }

                var os = null;
                try { os = require("os"); } catch (e) { }
                var desktopPath = (os ? os.homedir() : "").replace(/\\/g, "/") + "/Desktop";
                var filePath = desktopPath + "/compsaver_settings_" + Date.now() + ".json";

                try {
                    fs.writeFileSync(filePath, json, "utf8");
                    showToast("Settings exported to Desktop", "success");
                } catch (e) {
                    showToast("Export failed: " + e.message, "error");
                }
            });
        }

        // ── Import Settings (Task 7.1) ─────────────────────────────
        var importBtn = document.getElementById("btn-settings-import");
        if (importBtn) {
            importBtn.addEventListener("click", function () {
                csInterface.evalScript(
                    '(function(){ var f = File.openDialog("Import Settings", "JSON:*.json"); if (!f) return ""; f.open("r"); var c = f.read(); f.close(); return encodeBridge(c); })()',
                    function (hexContent) {
                        if (!hexContent) return;
                        var content = decodeBridge(hexContent);
                        if (!content) { showToast("Could not read file", "error"); return; }
                        var result = Settings.importJSON(content);
                        if (result.success) {
                            showToast("Settings imported successfully", "success");
                            SettingsPanel.refresh();
                        } else {
                            showToast(result.errors[0] || "Import failed", "error");
                        }
                    }
                );
            });
        }

        // ── Reset All Settings (Task 7.2) ──────────────────────────
        var resetAllBtn = document.getElementById("btn-settings-reset-all");
        if (resetAllBtn) {
            resetAllBtn.addEventListener("click", function () {
                CsDialog.confirm({
                    title: "Reset Settings",
                    message: "Reset ALL settings to defaults? This cannot be undone.",
                    okText: "Reset"
                }, function (ok) {
                    if (!ok) return;
                    Settings.reset();
                    SettingsPanel.refresh();
                    showToast("All settings reset to defaults", "success");
                });
            });
        }

        // ── Clear Preview Cache (Task 7.3) ─────────────────────────
        var clearCacheBtn = document.getElementById("btn-settings-clear-cache");
        if (clearCacheBtn) {
            clearCacheBtn.addEventListener("click", function () {
                if (_cacheClearing) return;
                CsDialog.confirm({
                    title: "Clear Preview Cache",
                    message: "Delete all preview cache files (.preview.apng)? Templates will still work but hover previews will need to regenerate.",
                    okText: "Clear"
                }, function (ok) {
                    if (!ok || _cacheClearing) return;

                    var fs = null;
                    try { fs = require("fs"); } catch (e) { }
                    if (!fs) { showToast("File system unavailable", "error"); return; }

                    var paths = (typeof libraryPaths !== "undefined" && libraryPaths.length > 0) ? libraryPaths : (rootPath ? [rootPath] : []);
                    if (paths.length === 0) { showToast("No library paths configured", "error"); return; }

                    // Batched async walk: ~15 fs ops per setTimeout slice so a large
                    // library cannot freeze the panel. Button stays disabled while running.
                    var BATCH = 15;
                    var queue = paths.slice();
                    var deletedCount = 0;
                    _cacheClearing = true;
                    clearCacheBtn.disabled = true;

                    function finish() {
                        _cacheClearing = false;
                        clearCacheBtn.disabled = false;
                        if (deletedCount > 0) {
                            showToast("Cleared " + deletedCount + " preview file" + (deletedCount === 1 ? "" : "s"), "success");
                        } else {
                            showToast("No cache files found", "info");
                        }
                    }

                    function slice() {
                        var ops = 0;
                        while (ops < BATCH && queue.length) {
                            var fullPath = queue.shift();
                            ops++;
                            var stat;
                            try { stat = fs.statSync(fullPath); } catch (e) { continue; }
                            if (stat.isDirectory()) {
                                try {
                                    var entries = fs.readdirSync(fullPath);
                                    var base = fullPath.replace(/\/+$/, "");
                                    for (var i = 0; i < entries.length; i++) queue.push(base + "/" + entries[i]);
                                } catch (e) { }
                            } else if (/\.preview\.(apng|webp)$/i.test(fullPath)) {
                                try { fs.unlinkSync(fullPath); deletedCount++; } catch (e) { }
                            }
                        }
                        if (queue.length) setTimeout(slice, 0);
                        else finish();
                    }
                    slice();
                });
            });
        }

        // ── About section links (Task 8.1) ─────────────────────────
        var aboutLinks = _container.querySelectorAll(".settings-link[data-url]");
        for (var al = 0; al < aboutLinks.length; al++) {
            aboutLinks[al].addEventListener("click", function (e) {
                e.preventDefault();
                var url = this.getAttribute("data-url");
                if (url) {
                    try { csInterface.openURLInDefaultBrowser(url); } catch (ex) {
                        try { window.open(url, "_blank"); } catch (ex2) { }
                    }
                }
            });
        }

        // ── About version display (Task 8.1) ───────────────────────
        try {
            var extInfo = csInterface.getExtensions(["com.lab.motion.panel"]);
            if (extInfo && extInfo[0] && extInfo[0].version) {
                var versionEl = _container.querySelector(".settings-about-version");
                if (versionEl) versionEl.textContent = "Version " + extInfo[0].version;
            }
        } catch (e) { }

        // ── Close open dropdowns on document click ─────────────────
        if (!_documentClickBound) {
            document.addEventListener("click", function () {
                if (!_container) return;
                var openSelects = _container.querySelectorAll(".settings-select.open");
                for (var c = 0; c < openSelects.length; c++) {
                    openSelects[c].classList.remove("open");
                    openSelects[c].querySelector(".settings-select-trigger").setAttribute("aria-expanded", "false");
                }
            });
            _documentClickBound = true;
        }
    }

    // ── Public API ─────────────────────────────────────────────────

    return {
        init: function () {
            _container = document.getElementById("settings-module");
        },

        /** Record the main module to return to when Back is pressed. */
        setReturnModule: function (module) {
            _returnModule = module || null;
        },

        open: function () {
            if (!_container) this.init();
            _container.innerHTML = _renderAll();
            _container.style.display = "";
            _isOpen = true;
            _bindEvents();
        },

        close: function () {
            if (_container) _container.style.display = "none";
            _isOpen = false;
        },

        refresh: function () {
            if (_isOpen && _container) {
                _container.innerHTML = _renderAll();
                _bindEvents();
            }
        },

        isOpen: function () {
            return _isOpen;
        }
    };

})();

// ============================================================
// CsDialog — themed confirm/prompt dialogs replacing native
// window.confirm()/window.prompt(). Reuses the existing
// .modal-overlay/.modal-content CSS and FocusTrap; no new design
// system. Callback-based (ES5):
//   CsDialog.confirm({title, message, okText, cancelText}, fn(ok))
//   CsDialog.prompt({title, label, value, okText, cancelText}, fn(ok, value))
// Escape or overlay click cancels (ok=false, value=null), matching
// native dialog semantics. Loaded before flow/colorflow/effects.
// ============================================================
var CsDialog = (function () {
    "use strict";

    var _overlay = null;
    var _keyHandler = null;

    function _escapeHTML(str) {
        return String(str == null ? "" : str)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function _close(ok, value, done) {
        if (_keyHandler) {
            document.removeEventListener("keydown", _keyHandler, true);
            _keyHandler = null;
        }
        if (typeof FocusTrap !== "undefined" && FocusTrap.isActive && FocusTrap.isActive()) {
            FocusTrap.deactivate();
        }
        var overlay = _overlay;
        _overlay = null;
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (typeof done === "function") done(ok, value);
    }

    function _open(opts, fieldHTML, done) {
        // Only one CsDialog at a time; drop the request while one is open.
        if (_overlay) return;
        opts = opts || {};

        var overlay = document.createElement("div");
        overlay.className = "modal-overlay cs-dialog";
        overlay.innerHTML =
            '<div class="modal-content">' +
                '<div class="modal-title">' + _escapeHTML(opts.title || "") + '</div>' +
                (opts.message
                    ? '<div class="modal-field"><label>' + _escapeHTML(opts.message) + '</label></div>'
                    : '') +
                (fieldHTML || '') +
                '<div class="modal-buttons">' +
                    '<button type="button" class="cs-dialog-cancel">' + _escapeHTML(opts.cancelText || "Cancel") + '</button>' +
                    '<button type="button" class="cs-dialog-ok">' + _escapeHTML(opts.okText || "OK") + '</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(overlay);
        overlay.classList.add("open");
        _overlay = overlay;

        var input = overlay.querySelector(".cs-dialog-input");

        function readValue() {
            return input ? input.value : null;
        }

        overlay.querySelector(".cs-dialog-ok").addEventListener("click", function () {
            _close(true, readValue(), done);
        });
        overlay.querySelector(".cs-dialog-cancel").addEventListener("click", function () {
            _close(false, null, done);
        });
        // Overlay click outside the content cancels, matching other app modals.
        overlay.addEventListener("click", function (e) {
            if (e.target === overlay) _close(false, null, done);
        });

        _keyHandler = function (e) {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                _close(false, null, done);
            } else if (e.key === "Enter" && input && e.target === input) {
                e.preventDefault();
                _close(true, readValue(), done);
            }
        };
        document.addEventListener("keydown", _keyHandler, true);

        if (typeof FocusTrap !== "undefined" && FocusTrap.activate) {
            FocusTrap.activate(overlay, document.activeElement);
        }
        if (input) {
            setTimeout(function () {
                if (!_overlay) return;
                input.focus();
                try { input.select(); } catch (e) { }
            }, 50);
        }
    }

    return {
        confirm: function (opts, done) {
            _open(opts, "", function (ok) {
                if (typeof done === "function") done(!!ok);
            });
        },

        prompt: function (opts, done) {
            opts = opts || {};
            var fieldHTML =
                '<div class="modal-field">' +
                    (opts.label ? '<label>' + _escapeHTML(opts.label) + '</label>' : '') +
                    '<input type="text" class="cs-dialog-input" aria-label="' +
                        _escapeHTML(opts.label || opts.title || "Input") + '" value="' +
                        _escapeHTML(opts.value || "") + '" placeholder="' +
                        _escapeHTML(opts.placeholder || "") + '">' +
                '</div>';
            _open(opts, fieldHTML, done);
        }
    };
})();
