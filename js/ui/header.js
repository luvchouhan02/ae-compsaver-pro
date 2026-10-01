// ============================================================
// ui/header.js - grid / footer / count shell helpers
// ------------------------------------------------------------
// Low-level shell helpers: grid blur lock, footer show/hide, the
// template-count badge, the category-panel close, and the icon-grid
// column sizing. Leaf helpers - depend only on globals (DOM, GRID_IDS,
// SECTIONS, MODULES, currentSection, currentMainModule, allTemplates,
// getTemplateSection). Called by section/module switching + templates.
// (switchSection/switchMainModule will join this module after the
//  Templates region is extracted.) Loaded before main.js.
// ============================================================

function blurGrid() {
    for (var i = 0; i < GRID_IDS.length; i++) {
        var g = document.getElementById(GRID_IDS[i]);
        if (g) {
            g.style.filter = "blur(3px)";
            g.style.pointerEvents = "none";
        }
    }
}

function unblurGrid() {
    for (var i = 0; i < GRID_IDS.length; i++) {
        var g = document.getElementById(GRID_IDS[i]);
        if (g) {
            g.style.filter = "none";
            g.style.pointerEvents = "auto";
        }
    }
}

function hideFooter() { if (DOM.footerArea) DOM.footerArea.style.display = "none"; }
function showFooter() { if (DOM.footerArea) DOM.footerArea.style.display = "block"; }

function updateCount() {
    if (!DOM["template-count"]) return;
    if (currentMainModule === MODULES.TOOLKIT) {
        DOM["template-count"].textContent = "TK";
        return;
    }
    var n = 0;
    for (var i = 0; i < allTemplates.length; i++) {
        if (getTemplateSection(allTemplates[i]) === currentSection) n++;
    }
    DOM["template-count"].textContent = n;
}

function closeCatPanel() {
    if (DOM["cat-panel"]) DOM["cat-panel"].classList.remove("open");
    if (DOM["btn-more-cats"]) DOM["btn-more-cats"].classList.remove("panel-open");
    showFooter();
    unblurGrid();
}

function forceIconGrid() {
    var grid = DOM["icon-list-container"];
    if (!grid) return;
    grid.style.display = "grid";
    if (currentSection === SECTIONS.ICON) {
        grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(52px, 1fr))";
        grid.classList.add("icon-mode");
        grid.classList.remove("overlay-mode");
    } else {
        grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(80px, 1fr))";
        grid.classList.add("overlay-mode");
        grid.classList.remove("icon-mode");
    }
}

// ── section / module switching ──────────────────────────────────
// switchMainModule/switchSection/switchToolkitSubSection + shell visibility,
// header layout, search reset, and toolkit-state reset. Depend on globals
// (templates render fns, effects/flow globals, modals helpers, selectedStaggerMode).

function setTemplateShellVisible(isVisible) {
    if (DOM.sectionSwitch) DOM.sectionSwitch.style.display = isVisible ? "flex" : "none";
    if (DOM.tabsWrapper) DOM.tabsWrapper.style.display = isVisible ? "flex" : "none";
    if (DOM.footerArea) DOM.footerArea.style.display = isVisible ? "block" : "none";

    if (!isVisible) {
        for (var i = 0; i < TEMPLATE_SECTION_IDS.length; i++) {
            var el = document.getElementById(TEMPLATE_SECTION_IDS[i]);
            if (el) el.style.display = "none";
        }
    }
}

function updateHeaderLayout() {
    var isToolkit = currentMainModule === MODULES.TOOLKIT;
    var isSettings = currentMainModule === MODULES.SETTINGS;

    if (DOM.countBadge) {
        DOM.countBadge.style.display = "none";
    }

    document.body.classList.toggle("mode-toolkit", isToolkit);
    document.body.classList.toggle("mode-settings", isSettings);
    document.body.classList.toggle("mode-templates", !isToolkit && !isSettings);
}

function clearTemplatesSearch() {
    if (DOM["search-box"]) {
        DOM["search-box"].value = "";
    }
    if (DOM.searchRow) {
        DOM.searchRow.classList.remove("expanded");
    }
    var inner = document.querySelector(".header-inner");
    if (inner) {
        inner.classList.remove("search-expanded");
    }
}

function resetToolkitStates() {
    // 1. Reset Tools cell highlight and stagger settings
    var apBtns = document.querySelectorAll(".tk-ap-btn");
    for (var i = 0; i < apBtns.length; i++) {
        apBtns[i].classList.remove("active");
    }

    selectedStaggerMode = "down";
    var modeBtns = document.querySelectorAll("[data-seq-mode]");
    for (var m = 0; m < modeBtns.length; m++) {
        modeBtns[m].classList.toggle("active", modeBtns[m].dataset.seqMode === "down");
    }
    var groupInput = document.getElementById("seq-group");
    var stepInput = document.getElementById("seq-step");
    if (groupInput) groupInput.value = "1";
    if (stepInput) stepInput.value = "5";

    // 2. Reset Effects presets deletion selections and category
    selectedPresetsForDeletion = [];
    var cards = document.querySelectorAll(".tk-effect-card.selected-for-delete");
    for (var j = 0; j < cards.length; j++) {
        cards[j].classList.remove("selected-for-delete");
    }
    var delBtn = document.getElementById("btn-tk-effects-delete");
    if (delBtn) delBtn.disabled = true;
    effectsSearchQuery = "";
    currentEffectsCategory = "ALL";
    var fxGrid = document.getElementById("tk-effects-grid");
    if (fxGrid) {
        renderEffectsGridOrEmpty(fxGrid, filterEffects(savedEffectsCache));
        renderCategorySystem(savedEffectsCache);
    }

    // 3. Reset Flow Graph curve, presets, and active tab
    if (typeof FlowSystem !== "undefined" && FlowSystem.setCurve) {
        FlowSystem.setCurve(33, 100, 66, 0);
        FlowSystem.selectedPreset = null;
        FlowSystem.activeTab = "built-in";
        var fTabs = document.querySelectorAll(".tk-flow-tab");
        for (var t = 0; t < fTabs.length; t++) {
            fTabs[t].classList.toggle("active", fTabs[t].dataset.flowTab === "built-in");
        }
        FlowSystem.renderPresets();
        var fCards = document.querySelectorAll('.tk-flow-preset-card');
        for (var c = 0; c < fCards.length; c++) fCards[c].classList.remove('selected');
        var fDelBtn = document.getElementById('btn-flow-delete-preset');
        var fFavBtn = document.getElementById('btn-flow-favorite');
        if (fDelBtn) fDelBtn.disabled = true;
        if (fFavBtn) fFavBtn.classList.remove('active');
    }
}

// CompSaverSidebar (ui/sidebar.js) is the only writer of Sidebar state
// (aria-current); the legacy .active toggling on .cs-sidebar-item is gone.
function updateSidebarNavState() {
}

// The Sidebar bindings live in ui/sidebar.js; the call site in init() stays.
function initSidebarNav() {
    if (typeof CompSaverSidebar !== "undefined" && CompSaverSidebar && typeof CompSaverSidebar.init === "function") {
        CompSaverSidebar.init();
    }
}

function switchMainModule(module) {
    if (typeof clearToast === "function") clearToast();
    currentMainModule = module;

    setActive("btn-main-toolkit", currentMainModule === MODULES.TOOLKIT);
    setActive("btn-main-templates", currentMainModule === MODULES.TEMPLATES);
    setActive("btn-settings-gear", currentMainModule === MODULES.SETTINGS);

    if (DOM["cat-panel"]) DOM["cat-panel"].classList.remove("open");
    unblurGrid();

    setDisplay("toolkit-module", currentMainModule === MODULES.TOOLKIT ? "flex" : "none");
    setDisplay("templates-module", currentMainModule === MODULES.TEMPLATES ? "flex" : "none");
    setDisplay("settings-module", currentMainModule === MODULES.SETTINGS ? "flex" : "none");

    setDisplay("sidebar-tk-switcher", currentMainModule === MODULES.TOOLKIT ? "flex" : "none");
    setDisplay("sidebar-tpl-switcher", currentMainModule === MODULES.TEMPLATES ? "flex" : "none");
    // Persistent vertical sidebar: stays visible in all modules
    setDisplay("app-sidebar", "flex");

    if (currentMainModule === MODULES.TOOLKIT) {
        resetToolkitStates();
        switchToolkitSubSection("tools");
    }

    if (currentMainModule === MODULES.SETTINGS) {
        setTemplateShellVisible(false);
        clearTemplatesSearch();
        SettingsPanel.open();
    }

    if (currentMainModule === MODULES.TEMPLATES) {
        setTemplateShellVisible(true);
        switchSection(SECTIONS.COMP);
    } else {
        setTemplateShellVisible(false);
        clearTemplatesSearch();
    }

    updateHeaderLayout();
    updateSidebarNavState();
    updateCount();

    // A switcher that was hidden (display:none) can't be measured; now that the
    // module's sidebar switcher is visible, re-run the presentation-only
    // Overflow_Menu reflow so it fits the current rail width. (Placement only.)
    if (typeof window.updateSwitcherOverflow === "function") {
        window.updateSwitcherOverflow();
    }
}

function switchToolkitSubSection(sub) {
    if (typeof clearToast === "function") clearToast();
    currentToolkitSubSection = sub;

    // Reset all toolkit states first so they are fresh when entered
    resetToolkitStates();

    setActive("btn-tk-tools", sub === "tools");
    setActive("btn-tk-effects", sub === "effects");
    setActive("btn-tk-graph", sub === "graph");
    setActive("btn-tk-text-anim", sub === "text-anim");
    setDisplay("toolkit-tools-view", sub === "tools" ? "flex" : "none");
    setDisplay("toolkit-effects-view", sub === "effects" ? "flex" : "none");
    setDisplay("toolkit-graph-view", sub === "graph" ? "flex" : "none");
    setDisplay("toolkit-text-anim-view", sub === "text-anim" ? "flex" : "none");
    setDisplay("toolkit-colorflow-view", sub === "colorflow" ? "flex" : "none");
    if (sub === "effects") loadSavedEffects();
    if (sub === "text-anim") TextAnim.load();
    updateSidebarNavState();
}

function switchSection(section) {
    if (typeof clearToast === "function") clearToast();
    section = normalizeSectionName(section);

    if (section === SECTIONS.TEXT) currentTextSection = SECTIONS.TEXT;

    currentSection = section;
    if (isImageSection(section)) currentImageSection = section;

    currentCategory = "All";

    // Reset templates search, close category panel, and scroll lists to top on tab switch
    clearTemplatesSearch();
    closeCatPanel();

    // Hide/show templates bulk delete button based on section (All template sub-sections)
    var btnTmpBulk = document.getElementById("btn-tmp-bulk-toggle");
    if (btnTmpBulk) {
        btnTmpBulk.style.display = "inline-flex";
    }
    setTmpBulkMode(false); // Reset bulk delete mode when switching sections

    // Hide/show Fast Media Engine import buttons
    var mediaBtns = document.querySelectorAll(".media-import-btn");
    var isMedia = (section === SECTIONS.FOOTAGE || isImageSection(section));
    for (var i = 0; i < mediaBtns.length; i++) {
        mediaBtns[i].style.display = isMedia ? "inline-flex" : "none";
    }

    var listContainers = [
        "comp-list-container", "icon-list-container", "transition-list-container",
        "text-list-container", "footage-list-container", "effect-list-container"
    ];
    for (var c = 0; c < listContainers.length; c++) {
        var el = DOM[listContainers[c]];
        if (el) el.scrollTop = 0;
    }

    var imgSection = isImageSection(currentSection);

    setActive("btn-section-comp", currentSection === SECTIONS.COMP);
    setActive("btn-section-png", currentSection === SECTIONS.ICON);
    setActive("btn-section-overlay", currentSection === SECTIONS.OVERLAY);
    setActive("btn-section-transition", currentSection === SECTIONS.LAYER);
    setActive("btn-section-text", isTextSection(currentSection));
    setActive("btn-section-footage", currentSection === SECTIONS.FOOTAGE);
    setActive("btn-section-effect", currentSection === SECTIONS.EFFECT);

    var subTabs = document.querySelectorAll(".sub-tab");
    for (var i = 0; i < subTabs.length; i++) {
        subTabs[i].classList.toggle("active", subTabs[i].dataset.type === currentSection);
    }

    setDisplay("section-comp", currentSection === SECTIONS.COMP ? "flex" : "none");
    setDisplay("section-images", imgSection ? "flex" : "none");
    setDisplay("section-transition", currentSection === SECTIONS.LAYER ? "flex" : "none");
    setDisplay("section-text", isTextSection(currentSection) ? "flex" : "none");
    setDisplay("section-footage", currentSection === SECTIONS.FOOTAGE ? "flex" : "none");
    setDisplay("section-effect", currentSection === SECTIONS.EFFECT ? "flex" : "none");

    if (imgSection) requestAnimationFrame(forceIconGrid);

    buildCategoryTabs();
    buildCategoryPanel();
    filterAndRender();
    updateCount();
}

// ── CompSaverHeader: status dot, utility icons, hidden hooks ─────
// Only CompMonitor changes the status dot, through setStatus (Req 8.2, 8.3).
var CompSaverHeader = (function () {
    "use strict";

    var STATUS_LABELS = {
        pending: "Checking After Effects",
        ok: "After Effects connected",
        warn: "After Effects not responding"
    };

    function byId(id) {
        return typeof document !== "undefined" ? document.getElementById(id) : null;
    }

    function setStatus(state) {
        if (!Object.prototype.hasOwnProperty.call(STATUS_LABELS, state)) return false;
        var dot = byId("cs-hdr-dot");
        if (!dot) return false;
        dot.setAttribute("data-state", state);
        dot.setAttribute("aria-label", STATUS_LABELS[state]);
        return true;
    }

    function getStatus() {
        var dot = byId("cs-hdr-dot");
        return dot ? dot.getAttribute("data-state") : null;
    }

    function init() {
        // The search toggle stays as a hidden hook only: it no longer opens
        // or closes the palette (the Sidebar trigger and Ctrl/Cmd+K do).
        var searchHook = typeof document !== "undefined" ? document.getElementById("btn-search-toggle") : null;
        if (searchHook) searchHook.hidden = true;
        bindNotifications();
    }

    // ── Notifications list (Req 8.11, 8.12, 8.15) ────────────────
    var TYPE_WORDS = { success: "Success", info: "Info", warning: "Warning", error: "Error" };
    var TYPE_ICONS = {
        success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><polyline points="8 12.5 11 15.5 16 9.5"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
        warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
    };
    var notifyBound = false;
    var notifyOpen = false;
    var notifyUnsub = null;
    var notifyEntries = [];

    function toastEngine() {
        return typeof CompSaverToast !== "undefined" ? CompSaverToast : null;
    }

    function renderNotifications(listEl, history) {
        var d = typeof document !== "undefined" ? document : null;
        var empty = byId("cs-notify-empty");
        if (!listEl || !d) return 0;
        listEl.textContent = "";
        var items = history || [];
        for (var i = 0; i < items.length; i++) {
            var type = TYPE_WORDS[items[i].type] ? items[i].type : "info";
            var li = d.createElement("li");
            li.className = "cs-notify__item";
            li.setAttribute("data-toast-type", type);
            var icon = d.createElement("span");
            icon.className = "cs-notify__icon";
            icon.setAttribute("aria-hidden", "true");
            icon.innerHTML = TYPE_ICONS[type];
            var word = d.createElement("span");
            word.className = "cs-visually-hidden";
            word.textContent = TYPE_WORDS[type] + ": ";
            var text = d.createElement("span");
            text.className = "cs-notify__text";
            var engine = toastEngine();
            text.textContent = engine && typeof engine.displayText === "function" ? engine.displayText(items[i].message, type) : String(items[i].message);
            li.appendChild(icon);
            li.appendChild(word);
            li.appendChild(text);
            listEl.appendChild(li);
        }
        if (empty) empty.hidden = items.length > 0;
        listEl.hidden = items.length === 0;
        return items.length;
    }

    function openNotifications() {
        var region = byId("cs-notify");
        var btn = byId("btn-hdr-notify");
        if (!region) return false;
        var engine = toastEngine();
        var max = engine && engine.HISTORY_MAX ? engine.HISTORY_MAX : 20;
        notifyEntries = engine && typeof engine.getHistory === "function" ? engine.getHistory() : [];
        renderNotifications(byId("cs-notify-list"), notifyEntries);
        region.hidden = false;
        if (btn) btn.setAttribute("aria-expanded", "true");
        notifyOpen = true;
        if (engine && typeof engine.onDisplay === "function" && !notifyUnsub) {
            notifyUnsub = engine.onDisplay(function (entry) {
                notifyEntries.unshift(entry);
                if (notifyEntries.length > max) notifyEntries.length = max;
                renderNotifications(byId("cs-notify-list"), notifyEntries);
            });
        }
        return true;
    }

    function closeNotifications() {
        var region = byId("cs-notify");
        var btn = byId("btn-hdr-notify");
        if (region) region.hidden = true;
        if (btn) btn.setAttribute("aria-expanded", "false");
        notifyOpen = false;
        if (typeof notifyUnsub === "function") notifyUnsub();
        notifyUnsub = null;
        return true;
    }

    function toggleNotifications() {
        return notifyOpen ? closeNotifications() : openNotifications();
    }

    function modalOpen() {
        if (typeof FocusTrap !== "undefined" && FocusTrap && typeof FocusTrap.isActive === "function" && FocusTrap.isActive()) return true;
        return !!(typeof document !== "undefined" && document.querySelector(".modal-overlay.open"));
    }

    function bindNotifications() {
        if (notifyBound || typeof document === "undefined") return;
        var btn = byId("btn-hdr-notify");
        if (!btn) return;
        notifyBound = true;
        btn.addEventListener("click", function () { toggleNotifications(); });
        document.addEventListener("keydown", function (e) {
            if (!notifyOpen || e.key !== "Escape") return;
            if (typeof CommandPalette !== "undefined" && CommandPalette && typeof CommandPalette.isOpen === "function" && CommandPalette.isOpen()) return;
            if (modalOpen()) return;
            closeNotifications();
        });
        document.addEventListener("click", function (e) {
            if (!notifyOpen) return;
            var region = byId("cs-notify");
            var t = e.target;
            if ((region && region.contains(t)) || btn.contains(t)) return;
            closeNotifications();
        });
    }

    var api = {
        STATUS_LABELS: STATUS_LABELS,
        init: init,
        setStatus: setStatus,
        getStatus: getStatus,
        toggleNotifications: toggleNotifications,
        openNotifications: openNotifications,
        closeNotifications: closeNotifications,
        renderNotifications: renderNotifications,
        isNotificationsOpen: function () { return notifyOpen; }
    };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    return api;
})();
