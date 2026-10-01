// ============================================================
// main.js — CompSaver UI Controller
// ============================================================

(function () {
    'use strict';

    window.onerror = function (msg, url, line) {
        console.error("[CompSaver Error] " + msg + " | Line: " + line + " | File: " + url);
        return true;
    };

    // SECTIONS, IMAGE_SECTIONS, MODULES, GRID_IDS, TEMPLATE_SECTION_IDS
    // are defined in core/constants.js (loaded before this file) and resolve
    // here via the global scope chain.

    // Shared singletons + app state (csInterface, rootPath, allTemplates,
    // nav/save/bulk state, and DOM) live in core/state.js, loaded before this
    // file and resolved here via the global scope chain.

    // ── Folder busy-set + templates refresh hook ───────────────────────
    // busyFolders + markFolderBusy/clearFolderBusy/isFolderBusy and the
    // loadTemplatesDebounced hook now live in core/state.js. Here we register
    // the real debounced refresh (which closes over the private loadTemplates)
    // into the global hook so the shared preview pipeline can trigger a refresh.
    var _loadTemplatesTimer = null;
    var _loadTemplatesTimerToken = null;
    var _searchDebounceTimerToken = null;
    var _previousModule = MODULES.TEMPLATES;
    loadTemplatesDebounced = function (delay) {
        if (_loadTemplatesTimerToken) { _loadTemplatesTimerToken.dispose(); _loadTemplatesTimerToken = null; }
        else if (_loadTemplatesTimer) clearTimeout(_loadTemplatesTimer);
        _loadTemplatesTimer = setTimeout(function () {
            _loadTemplatesTimer = null;
            if (_loadTemplatesTimerToken) { _loadTemplatesTimerToken.dispose(); _loadTemplatesTimerToken = null; }
            loadTemplates();
        }, typeof delay === "number" ? delay : 250);
        if (typeof FeatureFlags !== "undefined" && FeatureFlags.flags.lifecycleV1 &&
            typeof AppLifecycle !== "undefined") {
            _loadTemplatesTimerToken = AppLifecycle.register("timer", _loadTemplatesTimer, clearTimeout);
        }
    };

    // DOM cache object is declared in core/state.js; cacheDOM() populates it.
    function cacheDOM() {
        var ids = [
            "template-count", "search-box", "btn-browse", "btn-header-browse", "btn-refresh",
            "btn-main-toolkit", "btn-main-templates",
            "toolkit-module", "templates-module",
            "btn-section-comp", "btn-section-png", "btn-section-overlay", "btn-section-transition",
            "btn-section-text", "btn-section-footage", "btn-section-effect",
            "category-tabs", "btn-more-cats", "cat-panel", "cat-panel-list", "btn-close-cats",
            "chk-show-all-cats",
            "btn-save-main", "save-modal", "save-modal-title", "input-name",
            "input-new-cat", "save-dest-info", "btn-cancel", "btn-confirm-save",
            "cat-select-trigger", "cat-select-wrapper", "cat-select-value",
            "cat-select-dropdown", "modal-cat-select",
            "rename-modal", "rename-input", "btn-rename-cancel", "btn-rename-confirm",
            "move-modal", "btn-move-cancel", "btn-move-confirm",
            "move-cat-select-trigger", "move-cat-select-wrapper",
            "move-cat-select-value", "move-cat-select-dropdown",
            "icon-list-container", "comp-list-container", "transition-list-container",
            "text-list-container", "footage-list-container", "effect-list-container",
            "toast",
            "top-mini-logo", "brand-typo",
            "flow-graph-svg", "flow-curve-path", "flow-handle-1", "flow-handle-2",
            "flow-handle-line-1", "flow-handle-line-2", "flow-val-in", "flow-val-out",
            "flow-presets-grid",
            "btn-flow-reset", "btn-flow-apply", "btn-flow-reset-graph",
            "btn-tk-multi-precomp", "btn-tk-true-dup", "btn-seq-apply",
            "seq-step", "seq-group", "paste-drop-zone"
        ];
        for (var i = 0; i < ids.length; i++) {
            DOM[ids[i]] = document.getElementById(ids[i]);
        }
        DOM.sectionSwitch = document.querySelector(".compact-switcher");
        DOM.tabsWrapper = document.querySelector(".tabs-wrapper");
        DOM.footerArea = document.querySelector(".footer-area");
        DOM.searchRow = document.querySelector(".search-row");
        DOM.countBadge = document.querySelector(".brand-by");
    }

    // ── View_Fragment glue (obsidian-ui-redesign) ─────────────────────
    // The loader counts as present only when its MANIFEST is a real array,
    // so the Jest VM harnesses (whose missing globals resolve to an inert
    // Proxy) run every wrapped init call at once, exactly as before.
    function viewLoader() {
        return (typeof CompSaverViews !== "undefined" && CompSaverViews &&
            Array.isArray(CompSaverViews.MANIFEST) &&
            typeof CompSaverViews.mountSync === "function") ? CompSaverViews : null;
    }

    // Runs fn once the named fragment is in the DOM (Req 4.6); dropped when
    // the fragment failed to load (Req 4.11).
    function whenViewMounted(name, fn) {
        var views = viewLoader();
        if (!views) { fn(); return; }
        views.whenMounted(name, function () { fn(); });
    }

    function moduleForRoute(route) {
        if (route === "templates") return MODULES.TEMPLATES;
        if (route === "settings") return MODULES.SETTINGS;
        return MODULES.TOOLKIT;
    }

    // Mounts the overlays and the start Route's fragment before init(); when
    // the start fragment fails, the first Route in Sidebar order that mounts
    // becomes the start Route (Req 4.12).
    function mountStartViews(startRoute) {
        var views = viewLoader();
        if (!views) return startRoute;
        views.mountSync("overlays");
        if (views.mountSync(startRoute) === true) return startRoute;
        var order = ["templates", "tools", "effects", "text", "easing", "colorflow", "settings"];
        for (var i = 0; i < order.length; i++) {
            if (order[i] !== startRoute && views.mountSync(order[i]) === true) return order[i];
        }
        return startRoute;
    }

    // normalizeSectionName, getSafeName, getTemplateSection, isImageSection,
    // isTextSection, escapeHTML, escapeAttr are defined in core/utils.js.
    // encodeBridge / decodeBridge are defined in core/bridge.js.
    // All load before this file and resolve via the global scope chain.

    // bindClick, setDisplay, setActive live in core/dom.js, loaded before this file.

    // showToast + toastTimer live in ui/toast.js, loaded before this file.

    // =========================================================
    // GRID/FOOTER/COUNT SHELL HELPERS - extracted to js/ui/header.js
    // (blurGrid, unblurGrid, hideFooter, showFooter, updateCount)
    // =========================================================

    // =========================================================
    // SHELL: section/module switching - extracted to js/ui/header.js
    // (setTemplateShellVisible, updateHeaderLayout, clearTemplatesSearch,
    //  resetToolkitStates, switchMainModule, switchToolkitSubSection, switchSection)
    // =========================================================

    // =========================================================
    // SAVE-TYPE PICKER + CATEGORY/MOVE SELECT - extracted to js/ui/modals.js
    // (setSaveType, applyWallLogic, rebuildSaveModalCategories, init*Select,
    //  updateCustomSelect, updateMoveSelect)
    // =========================================================

    function connectDefaultLibrary(callback) {
        csInterface.evalScript("encodeBridge(getDefaultRootPath())", function (hexPath) {
            if (!hexPath) {
                showToast("Cannot connect to AE", "error");
                return;
            }
            var path = decodeBridge(hexPath).replace(/\\/g, "/");
            if (!path) {
                showToast("Invalid library path", "error");
                return;
            }
            rootPath = path;
            // Ensure the default path is at libraryPaths[0]
            if (libraryPaths.indexOf(rootPath) === -1) {
                libraryPaths.unshift(rootPath);
            }
            // If only the default path exists, set savePath to it
            if (libraryPaths.length === 1) {
                savePath = rootPath;
            }
            // Persist the resolved path set so the NEXT panel open can warm
            // paint straight from the persisted index (Req 1.1). Without this,
            // a user who only ever uses the default library never has
            // compSaver_libraryPaths in localStorage — only browseCustomLibrary
            // and the settings panel wrote it — so init()'s settings-restore
            // finds nothing, startupWarmPaint bails with "no-library-paths",
            // and every reopen falls through to a full cold ExtendScript scan
            // on After Effects' main thread.
            try {
                localStorage.setItem("compSaver_libraryPaths", JSON.stringify(libraryPaths));
            } catch (ePersistPaths) {
                /* best-effort: a quota failure only costs the next warm paint */
            }
            csInterface.evalScript('ensureFolder("' + encodeBridge(rootPath) + '")', function () {
                if (callback) callback();
            });
        });
    }

    function browseCustomLibrary(callback) {
        // Use AE native folder dialog via ExtendScript (consistent with AE's own UI)
        csInterface.evalScript('selectFolder()', function (hexPath) {
            if (!hexPath) {
                return;
            }
            var path = decodeBridge(hexPath).replace(/\\/g, "/");
            if (!path) {
                return;
            }
            // Check for duplicates against libraryPaths
            if (libraryPaths.indexOf(path) !== -1) {
                showToast("Path already connected", "info");
                return;
            }
            // Append the new path
            libraryPaths.push(path);
            // Update savePath to the newly added custom path
            savePath = path;
            // Persist libraryPaths to localStorage
            localStorage.setItem("compSaver_libraryPaths", JSON.stringify(libraryPaths));
            // Ensure the folder exists
            csInterface.evalScript('ensureFolder("' + encodeBridge(path) + '")', function () {
                loadTemplates();
                showToast("Library path added", "success");
                if (callback) callback();
            });
        });
    }

    var __CS_DEBUG__ = typeof FeatureFlags !== "undefined" && FeatureFlags.flags.debugHostReload === true;

    // =========================================================
    // STARTUP SESSION + TRACE (panel-reopen-startup)
    // =========================================================

    // One session per init() in this CEF context. Published on window so
    // templates.js can validate its async continuations against the current
    // generation. AppLifecycle.dispose flips `active` to false before the DOM
    // is torn down, so a late callback can never mutate a disposed context.
    var CSStartupSession = {
        generation: 0,
        active: false,
        begin: function () {
            CSStartupSession.generation++;
            CSStartupSession.active = true;
            if (typeof AppLifecycle !== "undefined" && AppLifecycle && AppLifecycle.onDispose) {
                AppLifecycle.onDispose(function () { CSStartupSession.active = false; });
            }
            return CSStartupSession.generation;
        },
        isCurrent: function (token) {
            return CSStartupSession.active === true && CSStartupSession.generation === token;
        }
    };
    window.CSStartupSession = CSStartupSession;

    // Inert recorder: every method is a total no-op, including print(). Used
    // whenever PerfEvents is absent or does not expose a usable recorder, so
    // callers never need a null check and never touch a foreign value.
    function inertStartupTrace() {
        function inertPhase() {
            return { end: function () { } };
        }
        return {
            beginPhase: inertPhase,
            noteWarmPaint: function () { },
            noteCache: function () { },
            noteValidity: function () { },
            countBridgeScan: function () { },
            noteBatch: function () { },
            noteReadiness: function () { },
            markUnavailable: function () { },
            report: function () { return null; },
            print: function () { }
        };
    }

    function beginStartupTrace() {
        if (typeof PerfEvents !== "undefined" && PerfEvents &&
            typeof PerfEvents.beginStartupTrace === "function") {
            var t = PerfEvents.beginStartupTrace({ generation: CSStartupSession.generation + 1 });
            if (t && typeof t.beginPhase === "function") return t;
        }
        return inertStartupTrace();
    }

    function retainSettingsSubscription(unsubscribe) {
        if (typeof FeatureFlags !== "undefined" && FeatureFlags.flags.lifecycleV1 &&
            typeof AppLifecycle !== "undefined") AppLifecycle.subscribe(unsubscribe);
        return unsubscribe;
    }

    function init() {
        var startupTrace = beginStartupTrace();
        var startupPhase = startupTrace.beginPhase("startup.init");
        var startupSession = CSStartupSession.begin();
        if (__CS_DEBUG__) {
            try {
                var extPath = csInterface.getSystemPath(SystemPath.EXTENSION);
                var jsxFile = extPath.replace(/\\/g, "/") + "/jsx/compSaver.jsx";
                csInterface.evalScript('$.evalFile("' + jsxFile + '")');
            } catch (eJsx) { }
        }
        cacheDOM();
        initCustomSelect();
        initMoveSelect();
        initSaveTypePicker();
        initToolkitNav();
        initSidebarNav();
        // Keyboard modality, CEP key registration (base set) and focus recovery.
        if (typeof CompSaverFocus !== "undefined" && CompSaverFocus && typeof CompSaverFocus.init === "function") CompSaverFocus.init();
        if (typeof CommandPalette !== "undefined" && CommandPalette.init) CommandPalette.init();
        whenViewMounted("tools", function () { initSequencerControls(); });
        initClipboardPaste();
        initCustomTooltips();
        whenViewMounted("colorflow", function () { ColorFlow.init(); });
        if (typeof CompMonitor !== "undefined" && CompMonitor && typeof CompMonitor.bind === "function") CompMonitor.bind();

        // Load effects grid (independent of library connection) once the
        // Effects fragment is in the DOM.
        whenViewMounted("effects", function () { loadSavedEffects(); });

        // Initialize the isolated Text Animation module (Toolkit > Text tab)
        whenViewMounted("text", function () { TextAnim.init(); });

        whenViewMounted("settings", function () { SettingsPanel.init(); });

        // ── Card size application ──────────────────────────────────────
        function applyCardSizes() {
            var body = document.body;
            // Template cards
            body.classList.remove("template-cards-medium", "template-cards-large");
            var tSize = Settings.get("ui.templateCardSize");
            if (tSize === "medium") body.classList.add("template-cards-medium");
            else if (tSize === "large") body.classList.add("template-cards-large");

            // Icon cards
            body.classList.remove("icon-cards-medium", "icon-cards-large");
            var iSize = Settings.get("ui.iconCardSize");
            if (iSize === "medium") body.classList.add("icon-cards-medium");
            else if (iSize === "large") body.classList.add("icon-cards-large");

            // TextAnim cards
            body.classList.remove("ta-cards-medium", "ta-cards-large");
            var taSize = Settings.get("ui.textAnimCardSize");
            if (taSize === "medium") body.classList.add("ta-cards-medium");
            else if (taSize === "large") body.classList.add("ta-cards-large");

            // A card size change re-lays out the grid: both the column count
            // (auto-fill against a new min card width) and the row pitch move.
            // The windowed grid sizes its spacers from those numbers, so without
            // this it keeps the old pitch and the tail of a long list becomes
            // unreachable — the scroll height no longer matches the list.
            remeasureWindowedGrids();
        }

        // Retire the windowed grid's cached metrics and repaint the section grid
        // for the offset the user is at. Deferred one frame so the new body
        // classes are actually laid out before anything is measured.
        function remeasureWindowedGrids() {
            if (typeof VirtualGrid === "undefined" || !VirtualGrid ||
                typeof VirtualGrid.invalidateMetrics !== "function") return;
            VirtualGrid.invalidateMetrics();
            var repaint = function () {
                if (typeof syncSectionGridWindow === "function") {
                    try { syncSectionGridWindow(); } catch (syncError) { }
                }
            };
            if (typeof requestAnimationFrame === "function") requestAnimationFrame(repaint);
            else setTimeout(repaint, 16);
        }
        applyCardSizes();
        retainSettingsSubscription(Settings.onChange("ui.templateCardSize", applyCardSizes));
        retainSettingsSubscription(Settings.onChange("ui.iconCardSize", applyCardSizes));
        retainSettingsSubscription(Settings.onChange("ui.textAnimCardSize", applyCardSizes));

        // ── Density_Mode application (Req 4.6, 4.7, 5.2–5.5, 21.2–21.3) ──
        // Panel-level compact/expanded density driven by body[data-density].
        // Compact is the first-load default (Req 5.2): Settings.get falls back
        // to the "compact" default, and the persisted choice re-applies on
        // reload (Req 4.6). Flipping data-density re-resolves the --space-*
        // scale across every Module instantly (Req 4.7) — every control stays
        // present and interactive because nothing is added/removed, only the
        // spacing tokens change (Req 5.5). The `.density-switching` class
        // suppresses padding/margin/gap transitions for one frame so the
        // switch is INSTANT and never animates layout properties (Req 21.2/21.3).
        function applyDensity(mode) {
            var density = (mode === "expanded") ? "expanded" : "compact";
            var body = document.body;
            if (body.getAttribute("data-density") === density) return;
            body.classList.add("density-switching");
            body.setAttribute("data-density", density);
            // Force a reflow so the suppressed transitions take effect this frame.
            void body.offsetWidth;
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    body.classList.remove("density-switching");
                });
            });
            // Density re-resolves the --space-* scale, which moves the grid's
            // row gap and card padding: the windowed grid's cached pitch is
            // stale from here on.
            remeasureWindowedGrids();
        }
        applyDensity(Settings.get("ui.density"));
        retainSettingsSubscription(Settings.onChange("ui.density", applyDensity));

        // ── Accent Theme System ─────────────────────────────────────────
        // Token-driven accent recolor. Reads the persisted accent, applies it
        // by overriding the accent token family inline on <html> at runtime
        // (no restart), and subscribes for live preset/custom changes. "blue"
        // clears overrides so the frozen :root accent applies byte-identically.
        if (typeof Accent !== "undefined" && Accent.init) {
            Accent.init();
        }

        // Restore persisted library paths from localStorage
        var settingsPhase = startupTrace.beginPhase("startup.settings-restore");
        try {
            var storedPaths = localStorage.getItem("compSaver_libraryPaths");
            if (storedPaths) {
                var parsed = JSON.parse(storedPaths);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    libraryPaths = parsed;
                    rootPath = libraryPaths[0];
                    savePath = libraryPaths[libraryPaths.length - 1];
                }
            }
        } catch (e) {
            // If parsing fails, start fresh
            libraryPaths = [];
        }
        settingsPhase.end();

        // Try to load LibraryIndex for instant startup
        var indexPhase = startupTrace.beginPhase("startup.index-load");
        var li = typeof loadLibraryIndex === "function" ? loadLibraryIndex() : null;
        indexPhase.end();
        if (li) {
            // Trigger background cache validation, non-blocking
            var metadataTimer = setTimeout(function () {
                if (typeof loadMetadataCache === "function") {
                    loadMetadataCache();
                }
            }, 500);
            if (typeof FeatureFlags !== "undefined" && FeatureFlags.flags.lifecycleV1 &&
                typeof AppLifecycle !== "undefined") AppLifecycle.register("timer", metadataTimer, clearTimeout);
        }

        var lifecycleLibraryWorkId = "default-library";
        var lifecycleLibraryMode = typeof FeatureFlags !== "undefined" &&
            FeatureFlags.flags.lifecycleV1 && typeof AppLifecycle !== "undefined";
        if (lifecycleLibraryMode) AppLifecycle.markWorkStart("startup", lifecycleLibraryWorkId);

        // Optimistic warm paint straight from the persisted index. No bridge
        // call, no synchronous disk validity key. `painted` is compared with a
        // strict boolean literal: a sandbox Proxy passes `typeof === "function"`
        // but must not be treated as a successful paint. It binds to the
        // Templates grid, so it runs once that fragment is mounted (at once when
        // Templates is the start Route, else in the SHELL_VISIBLE task).
        var warmPainted = false;
        whenViewMounted("templates", function () {
            var warmPaint = typeof startupWarmPaint === "function" ? startupWarmPaint(li) : null;
            warmPainted = !!(warmPaint && warmPaint.painted === true);
            if (!warmPainted && typeof showStartupLoadingState === "function") showStartupLoadingState();
        });

        // Readiness is declared lexically in init() and started outside the
        // connectDefaultLibrary callback, so warm paint alone can satisfy
        // FIRST_CARD_USABLE / LIBRARY_READY without either evalScript round trip.
        if (lifecycleLibraryMode) {
            var readinessChecks = 0;
            var readinessTimerToken = null;
            var readinessTimer = setInterval(function () {
                readinessChecks++;
                var countEl = document.getElementById("template-count");
                var firstCard = document.querySelector(".card, .icon-card");
                var primaryAction = firstCard && firstCard.querySelector("button");
                var visibleImages = document.querySelectorAll(".card img, .icon-card img");
                var imagesReady = true;
                for (var i = 0; i < visibleImages.length; i++) {
                    if (!visibleImages[i].complete) { imagesReady = false; break; }
                }
                var activeSectionCount = 0;
                for (var j = 0; j < allTemplates.length; j++) {
                    if (getTemplateSection(allTemplates[j]) === currentSection) activeSectionCount++;
                }
                var countReady = currentMainModule !== MODULES.TEMPLATES ||
                    (countEl && parseInt(countEl.textContent || "0", 10) === activeSectionCount);

                if (allTemplates.length > 0 && firstCard && primaryAction && countReady && imagesReady) {
                    clearInterval(readinessTimer);
                    if (readinessTimerToken) readinessTimerToken.dispose();
                    AppLifecycle.transition("FIRST_CARD_USABLE");
                    AppLifecycle.transition("LIBRARY_READY");
                    AppLifecycle.markWorkEnd("startup", lifecycleLibraryWorkId);
                } else if (readinessChecks >= 1200) {
                    clearInterval(readinessTimer);
                    if (readinessTimerToken) readinessTimerToken.dispose();
                    AppLifecycle.transition("DEGRADED");
                    AppLifecycle.markWorkEnd("startup", lifecycleLibraryWorkId);
                }
            }, 25);
            readinessTimerToken = AppLifecycle.register("timer", readinessTimer, clearInterval);
        }

        // connectDefaultLibrary is still responsible for rootPath discovery,
        // ensureFolder, and the cold scan. loadTemplates only runs when warm
        // paint did not already serve this exact path set.
        var rootDiscoveryPhase = startupTrace.beginPhase("startup.root-discovery");
        connectDefaultLibrary(function () {
            rootDiscoveryPhase.end();
            if (typeof templatesWarmPaintServed !== "function" ||
                templatesWarmPaintServed() !== true) {
                loadTemplates();
            }
        });

        // Templates toolbar, section, bulk and search bindings (templates fragment).
        whenViewMounted("templates", function () {
            // Bind templates bulk delete controls
            var btnTmpBulk = document.getElementById("btn-tmp-bulk-toggle");
            if (btnTmpBulk) {
                btnTmpBulk.addEventListener("click", function () {
                    var confirmEl = document.getElementById("tmp-bulk-confirm");
                    if (tmpBulkMode && tmpBulkSelected.length > 0) {
                        if (confirmEl) confirmEl.classList.add("show");
                        return;
                    }
                    setTmpBulkMode(!tmpBulkMode);
                });
            }

            var btnTmpBulkConfirm = document.getElementById("btn-tmp-bulk-confirm");
            if (btnTmpBulkConfirm) {
                btnTmpBulkConfirm.addEventListener("click", performTmpBulkDelete);
            }

            var btnTmpBulkCancel = document.getElementById("btn-tmp-bulk-cancel");
            if (btnTmpBulkCancel) {
                btnTmpBulkCancel.addEventListener("click", function () {
                    var confirmEl = document.getElementById("tmp-bulk-confirm");
                    if (confirmEl) confirmEl.classList.remove("show");
                });
            }

            bindClick("btn-section-comp", function () { switchSection(SECTIONS.COMP); });
            bindClick("btn-section-png", function () { switchSection(SECTIONS.ICON); });
            bindClick("btn-section-overlay", function () { switchSection(SECTIONS.OVERLAY); });
            bindClick("btn-section-transition", function () { switchSection(SECTIONS.LAYER); });
            bindClick("btn-section-text", function () { switchSection(SECTIONS.TEXT); });
            bindClick("btn-section-footage", function () { switchSection(SECTIONS.FOOTAGE); });
            bindClick("btn-section-effect", function () { switchSection(SECTIONS.EFFECT); });

            bindClick("btn-browse", function () {
                browseCustomLibrary();
            });

            bindClick("btn-refresh-templates", function () {
                var btn = document.getElementById("btn-refresh-templates");
                if (btn) {
                    btn.classList.add("spin-once");
                    setTimeout(function () { btn.classList.remove("spin-once"); }, 600);
                }
                loadTemplates();
            });

            var subTabs = document.querySelectorAll(".sub-tab");
            for (var i = 0; i < subTabs.length; i++) {
                subTabs[i].addEventListener("click", function () { switchSection(this.dataset.type); });
            }

            bindClick("btn-more-cats", function () {
                var panel = DOM["cat-panel"];
                var moreBtn = DOM["btn-more-cats"];
                if (!panel) return;
                panel.classList.toggle("open");
                if (panel.classList.contains("open")) {
                    if (moreBtn) moreBtn.classList.add("panel-open");
                    hideFooter(); blurGrid();
                } else {
                    if (moreBtn) moreBtn.classList.remove("panel-open");
                    showFooter(); unblurGrid();
                }
            });

            bindClick("btn-close-cats", closeCatPanel);

            if (DOM["chk-show-all-cats"]) {
                DOM["chk-show-all-cats"].addEventListener("change", function () {
                    saveShowAllInline(this.checked);
                    buildCategoryTabs();
                    buildCategoryPanel();
                });
            }

            if (DOM["search-box"]) {
                DOM["search-box"].addEventListener("input", function () {
                    if (_searchDebounceTimerToken) { _searchDebounceTimerToken.dispose(); _searchDebounceTimerToken = null; }
                    else clearTimeout(searchDebounceTimer);
                    searchDebounceTimer = setTimeout(function () {
                        searchDebounceTimer = null;
                        if (_searchDebounceTimerToken) { _searchDebounceTimerToken.dispose(); _searchDebounceTimerToken = null; }
                        filterAndRender();
                    }, Settings.get("performance.searchDebounce"));
                    if (typeof FeatureFlags !== "undefined" && FeatureFlags.flags.lifecycleV1 &&
                        typeof AppLifecycle !== "undefined") {
                        _searchDebounceTimerToken = AppLifecycle.register("timer", searchDebounceTimer, clearTimeout);
                    }
                });
            }

            bindClick("btn-save-main", openSaveModal);
        });

        bindClick("btn-header-browse", function () {
            browseCustomLibrary();
        });

        bindClick("btn-settings-gear", function () {
            if (currentMainModule === MODULES.SETTINGS) {
                switchMainModule(_previousModule || MODULES.TEMPLATES);
            } else {
                _previousModule = currentMainModule;
                switchMainModule(MODULES.SETTINGS);
            }
        });



        // btn-search-toggle is a hidden Header hook now (CompSaverHeader); the
        // visible palette entry points are the Sidebar trigger and Ctrl/Cmd+K.
        if (typeof CompSaverHeader !== "undefined" && CompSaverHeader && typeof CompSaverHeader.init === "function") {
            CompSaverHeader.init();
        }

        if (DOM["btn-refresh"]) {
            DOM["btn-refresh"].addEventListener("click", function () {
                var btn = this;
                btn.classList.add("spinning");
                setTimeout(function () {
                    loadTemplates();
                    btn.classList.remove("spinning");
                    showToast("Refreshed", "success");
                }, 300);
            });
        }

        whenViewMounted("effects", function () { bindEffectsViewControls(); });

        function bindEffectsViewControls() {
        bindClick("btn-tk-effects-refresh", function () {
            var btn = this;
            btn.classList.add("spinning");

            // Clear the active grid container and flush local UI status
            var grid = document.getElementById("tk-effects-grid");
            if (grid) {
                grid.innerHTML = '<div class="tk-empty-state cs-empty-state"><span class="cs-empty-state__title">Refreshing presets...</span></div>';
            }

            setTimeout(function () {
                // Re-trigger the filesystem cache readout natively and clean-render
                var files = scanEffectsFolder();
                savedEffectsCache = files;
                renderCategorySystem(files);
                if (grid) {
                    renderEffectsGridOrEmpty(grid, filterEffects(files));
                }
                btn.classList.remove("spinning");
                showToast("Presets refreshed", "success");
            }, 300);
        });

        bindClick("btn-tk-bulk-import", handleBulkImport);
        bindEffectsBulkDeleteControls();
        }

        bindClick("btn-tk-save-preset-cancel", function () {
            window._taTextAnimSavePending = false;
            FocusTrap.deactivate();
            var modal = document.getElementById("tk-save-preset-modal");
            if (modal) modal.classList.remove("open");
        });

        // Backdrop click to dismiss save-preset modal
        var savePresetOverlay = document.getElementById("tk-save-preset-modal");
        if (savePresetOverlay) {
            savePresetOverlay.addEventListener("click", function (e) {
                if (e.target === savePresetOverlay) {
                    window._taTextAnimSavePending = false;
                    FocusTrap.deactivate();
                    savePresetOverlay.classList.remove("open");
                }
            });
        }

        bindClick("btn-tk-save-preset-confirm", confirmPresetSave);

        function bindEffectsBulkDeleteControls() {
        bindClick("btn-tk-bulk-delete-toggle", function () {
            var toggleBtn = document.getElementById("btn-tk-bulk-delete-toggle");
            var confirmWrap = document.getElementById("tk-bulk-delete-confirm-wrap");

            // If presets are selected, clicking the trash button triggers the confirmation overlay!
            if (isBulkDeleteModeActive && selectedPresetsForDeletion.length > 0) {
                if (confirmWrap) {
                    confirmWrap.style.display = "block";
                }
                return;
            }

            isBulkDeleteModeActive = !isBulkDeleteModeActive;

            if (isBulkDeleteModeActive) {
                if (toggleBtn) {
                    toggleBtn.classList.add("active");
                    toggleBtn.style.color = "#ef4444";
                    toggleBtn.style.borderColor = "rgba(239, 68, 68, 0.4)";
                    toggleBtn.style.background = "rgba(239, 68, 68, 0.08)";
                }
                selectedPresetsForDeletion = [];
                var countSpan = document.getElementById("tk-delete-count");
                if (countSpan) {
                    countSpan.textContent = "(0)";
                    countSpan.style.display = "none";
                }
                showToast("Bulk Delete Mode active. Click presets to select.", "info");
            } else {
                deactivateBulkDeleteMode();
                showToast("Bulk Delete Mode deactivated.", "info");
            }
        });

        bindClick("btn-tk-bulk-delete-cancel", function () {
            deactivateBulkDeleteMode();
        });

        bindClick("btn-tk-bulk-delete-confirm", function () {
            if (selectedPresetsForDeletion.length === 0) return;

            var deletedCount = 0;
            for (var i = 0; i < selectedPresetsForDeletion.length; i++) {
                var filePath = selectedPresetsForDeletion[i];
                try {
                    if (nodeFs.existsSync(filePath)) {
                        nodeFs.unlinkSync(filePath);
                        deletedCount++;
                    }
                } catch (err) {
                    console.error("Failed to delete physical file:", filePath, err.message);
                }
            }

            showToast("Successfully deleted " + deletedCount + " presets physically!", "success");

            // Deactivate and clear selection visually and logically
            deactivateBulkDeleteMode();

            // Re-trigger scanning and render
            var grid = document.getElementById("tk-effects-grid");
            if (grid) {
                var files = scanEffectsFolder();
                savedEffectsCache = files;
                renderCategorySystem(files);
                renderEffectsGridOrEmpty(grid, filterEffects(files));
            }
        });

        }

        function deactivateBulkDeleteMode() {
            isBulkDeleteModeActive = false;
            var toggleBtn = document.getElementById("btn-tk-bulk-delete-toggle");
            var confirmWrap = document.getElementById("tk-bulk-delete-confirm-wrap");
            var countSpan = document.getElementById("tk-delete-count");

            if (toggleBtn) {
                toggleBtn.classList.remove("active");
                toggleBtn.style.color = "";
                toggleBtn.style.borderColor = "";
                toggleBtn.style.background = "";
            }
            if (countSpan) {
                countSpan.textContent = "(0)";
                countSpan.style.display = "none";
            }
            if (confirmWrap) {
                confirmWrap.style.display = "none";
            }

            // Clear selections visually
            var grid = document.getElementById("tk-effects-grid");
            if (grid) {
                var selectedCards = grid.querySelectorAll(".tk-effect-card.selected-for-delete");
                for (var i = 0; i < selectedCards.length; i++) {
                    selectedCards[i].classList.remove("selected-for-delete");
                }
            }
            selectedPresetsForDeletion = [];
        }

        bindClick("btn-cancel", closeSaveModal);
        bindClick("btn-confirm-save", confirmSave);

        if (DOM["save-modal"]) {
            DOM["save-modal"].addEventListener("click", function (e) {
                if (e.target === this) closeSaveModal();
            });
        }

        bindClick("btn-rename-cancel", closeRenameModal);
        bindClick("btn-rename-confirm", confirmRename);

        if (DOM["rename-modal"]) {
            DOM["rename-modal"].addEventListener("click", function (e) {
                if (e.target === this) closeRenameModal();
            });
        }

        if (DOM["rename-input"]) {
            DOM["rename-input"].addEventListener("keydown", function (e) {
                if (e.key === "Enter") confirmRename();
                if (e.key === "Escape") closeRenameModal();
            });
        }

        bindClick("btn-move-cancel", closeMoveModal);
        bindClick("btn-move-confirm", confirmMove);

        if (DOM["move-modal"]) {
            DOM["move-modal"].addEventListener("click", function (e) {
                if (e.target === this) closeMoveModal();
            });
        }

        bindClick("btn-tk-effects-rename-cancel", closePresetRenameModal);
        bindClick("btn-tk-effects-rename-confirm", confirmPresetRename);

        bindClick("btn-tk-effects-delete-cancel", closePresetDeleteModal);
        bindClick("btn-tk-effects-delete-confirm", confirmPresetDelete);

        var renamePresetOverlay = document.getElementById("tk-effects-rename-modal");
        if (renamePresetOverlay) {
            renamePresetOverlay.addEventListener("click", function (e) {
                if (e.target === renamePresetOverlay) closePresetRenameModal();
            });
        }

        var deletePresetOverlay = document.getElementById("tk-effects-delete-modal");
        if (deletePresetOverlay) {
            deletePresetOverlay.addEventListener("click", function (e) {
                if (e.target === deletePresetOverlay) closePresetDeleteModal();
            });
        }

        var renamePresetInput = document.getElementById("tk-effects-rename-input");
        if (renamePresetInput) {
            renamePresetInput.addEventListener("keydown", function (e) {
                if (e.key === "Enter") {
                    e.preventDefault();
                    confirmPresetRename();
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    closePresetRenameModal();
                }
            });
        }

        document.addEventListener("click", function (e) {
            var panel = DOM["cat-panel"];
            var moreBtn = DOM["btn-more-cats"];
            if (panel && moreBtn &&
                !panel.contains(e.target) &&
                !moreBtn.contains(e.target) &&
                panel.classList.contains("open")) {
                closeCatPanel();
            }

            // Clear presets active selection when clicking outside
            if (!e.target.closest(".tk-effect-card") && !e.target.closest("#tk-effects-delete-modal")) {
                var grid = document.getElementById("tk-effects-grid");
                if (grid) {
                    var selected = grid.querySelector(".tk-effect-card.is-selected");
                    if (selected) {
                        selected.classList.remove("is-selected");
                    }
                }
            }
        });

        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") {
                closeSaveModal();
                closeRenameModal();
                closeMoveModal();
                closePresetRenameModal();
                closePresetDeleteModal();
                // Close bounce-settings and save-preset modals
                var bounceModal = document.getElementById("bounce-settings-modal");
                if (bounceModal && bounceModal.classList.contains("open")) {
                    FocusTrap.deactivate();
                    bounceModal.classList.remove("open");
                }
                var savePresetModal = document.getElementById("tk-save-preset-modal");
                if (savePresetModal && savePresetModal.classList.contains("open")) {
                    window._taTextAnimSavePending = false;
                    FocusTrap.deactivate();
                    savePresetModal.classList.remove("open");
                }
                closeCatPanel();
                var popups = document.querySelectorAll(".icon-more-popup");
                for (var p = 0; p < popups.length; p++) popups[p].remove();
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key === "f") {
                e.preventDefault();
                if (currentMainModule !== MODULES.TEMPLATES) return;
                if (DOM["search-box"]) { DOM["search-box"].focus(); DOM["search-box"].select(); }
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                e.preventDefault();
                if (currentMainModule !== MODULES.TEMPLATES) return;
                openSaveModal();
            }
        });

        attachGlobalCardDelegation();
        attachGlobalIconDelegation();

        // Close the init span. `warmPainted` is a real boolean here. All timing
        // arithmetic stays in the trace recorder — nothing is subtracted in
        // main.js.
        startupPhase.end({ warmPainted: warmPainted });
        if (__CS_DEBUG__) startupTrace.print();
    }

    // =========================================================
    // TOOLKIT NAV + ACTIONS - extracted to js/toolkit/toolkit.js
    // (initToolkitNav, runToolkitAction; init() calls initToolkitNav())
    // =========================================================

    // =========================================================
    // EFFECTS PRESETS ENGINE - extracted to js/toolkit/effects.js
    // (scan/save/apply/favorite/rename/delete/bulk-import + grid render;
    //  loaded before main.js, resolved via global scope)
    // =========================================================

    // =========================================================
    // TEMPLATES MODULE - extracted to js/templates/templates.js
    // (library/category/render/operations/save; loaded before main.js,
    //  resolved via global scope. init()/switchSection call into it.)
    // =========================================================

    function windowResizeFix() {
        if (isImageSection(currentSection)) forceIconGrid();
        updateSwitcherOverflow();
    }

    // =========================================================
    // SECTION_SWITCHER OVERFLOW — CEP-safe, presentation-only helper
    // ---------------------------------------------------------
    // A single generic helper that keeps every Section_Switcher on ONE line
    // across the Dock_Range (Req 9.8, 10.6, 14.10). Chromium 88 forbids :has()
    // and @container, so overflow is detected by measurement: it compares the
    // switcher track's available extent against each button's NATURAL extent
    // and, when the row can't fit, MOVES (reparents — never clones) the
    // lowest-priority buttons into the shared <details class="switcher-overflow">
    // body, moving them back when space returns. Because the real node is
    // relocated with its id, data-* and already-attached click handler intact,
    // every selector still resolves to exactly one element and behavior is
    // byte-for-byte unchanged (Req 3.1-3.5). No feature logic is added — the
    // helper only changes WHERE an existing node lives. It reuses the existing
    // resize hook (windowResizeFix); no new event feature is introduced.
    // =========================================================

    // Capture (once) the switcher's movable buttons in their authored order so
    // relocation is stable and reversible. Real nodes, so identity is preserved.
    function getSwitcherButtons(overflowEl, track, body) {
        if (!overflowEl._switcherButtons) {
            var arr = [];
            var kids = track.children;
            for (var i = 0; i < kids.length; i++) {
                if (kids[i].tagName === "BUTTON") arr.push(kids[i]);
            }
            var bkids = body.children;
            for (var j = 0; j < bkids.length; j++) {
                if (bkids[j].tagName === "BUTTON") arr.push(bkids[j]);
            }
            overflowEl._switcherButtons = arr;
        }
        return overflowEl._switcherButtons;
    }

    function reflowSwitcher(overflowEl) {
        var track = overflowEl.parentNode;
        if (!track) return;
        var body = overflowEl.querySelector(".switcher-overflow__body");
        if (!body) return;
        // Skip while the switcher isn't laid out (its Module is hidden): a zero
        // width would spuriously relocate everything. It reflows on next show.
        if (!track.clientWidth || track.offsetParent === null) return;

        // Horizontal-rail relocation only. CompSaver's section switchers render
        // as VERTICAL stacks inside the slim sidebar, where buttons wrap onto
        // their own rows and simply scroll — there is no single-line overflow to
        // resolve, and horizontal width measurement would spuriously relocate
        // every button into "More". Skip any vertically-laid-out switcher.
        var trackDir = window.getComputedStyle(track).flexDirection;
        if (trackDir === "column" || trackDir === "column-reverse") {
            overflowEl.classList.remove("has-items");
            return;
        }

        var btns = getSwitcherButtons(overflowEl, track, body);
        if (!btns.length) return;

        var i;
        // 1) Restore every button into the track in authored order (real nodes),
        //    giving a clean baseline to measure from.
        for (i = 0; i < btns.length; i++) {
            track.insertBefore(btns[i], overflowEl);
        }
        overflowEl.classList.remove("has-items");

        // 2) Measure available track extent + each button's NATURAL extent.
        var cs = window.getComputedStyle(track);
        var gap = parseFloat(cs.columnGap || cs.gap) || 0;
        var padL = parseFloat(cs.paddingLeft) || 0;
        var padR = parseFloat(cs.paddingRight) || 0;
        var avail = track.clientWidth - padL - padR;

        for (i = 0; i < btns.length; i++) btns[i].style.flex = "0 0 auto";
        void track.offsetWidth; // one synchronous reflow, then read
        var nat = [];
        for (i = 0; i < btns.length; i++) nat[i] = btns[i].offsetWidth;
        for (i = 0; i < btns.length; i++) btns[i].style.flex = "";

        var total = 0;
        for (i = 0; i < btns.length; i++) total += nat[i];
        total += gap * (btns.length - 1);
        if (total <= avail + 0.5) return; // everything fits on one line

        // 3) Reserve room for the "More" trigger, then keep the highest-priority
        //    buttons that fit and relocate the rest (lowest priority first).
        overflowEl.classList.add("has-items");
        void track.offsetWidth;
        var reserve = overflowEl.offsetWidth + gap;
        var availBtns = avail - reserve;

        var used = 0;
        var keep = 0;
        for (i = 0; i < btns.length; i++) {
            var w = nat[i] + (i > 0 ? gap : 0);
            if (keep === 0 || used + w <= availBtns) {
                used += w;
                keep++;
            } else {
                break;
            }
        }
        if (keep >= btns.length) {
            overflowEl.classList.remove("has-items");
            return;
        }
        for (i = keep; i < btns.length; i++) {
            body.appendChild(btns[i]);
        }
    }

    function updateSwitcherOverflow() {
        try {
            var overflows = document.querySelectorAll(".switcher-overflow");
            for (var i = 0; i < overflows.length; i++) {
                reflowSwitcher(overflows[i]);
            }
        } catch (e) {
            // Presentation-only: never let a measurement error break the panel.
            console.warn("[CompSaver] switcher overflow reflow skipped:", e);
        }
    }

    // Expose so the module/section switch (in ui/header.js) can re-run the
    // reflow when a previously-hidden switcher becomes visible.
    window.updateSwitcherOverflow = updateSwitcherOverflow;

    function bootstrapPanel() {
        var lifecycleMode = typeof FeatureFlags !== "undefined" && FeatureFlags.flags.lifecycleV1 === true;
        var pingToken = null;
        try {
            // Obsidian Shell: T0 for the fragment watchdog, the startup gates,
            // and the per-mount DOM refresh / toolkit control binding.
            var views = viewLoader();
            if (views) {
                views.begin();
                views.onMounted(function (name, rootEl) {
                    cacheDOM();
                    if (typeof bindToolkitActionControls === "function") bindToolkitActionControls(rootEl);
                });
            }
            var startModule = Settings.get("ui.defaultTab") === "toolkit" ? MODULES.TOOLKIT : MODULES.TEMPLATES;
            var startRoute = startModule === MODULES.TOOLKIT ? "tools" : "templates";
            if (typeof StartupGate !== "undefined" && StartupGate && typeof StartupGate.arm === "function") {
                StartupGate.arm({
                    activeRoute: function () {
                        var r = typeof CompSaverRouter !== "undefined" && CompSaverRouter &&
                            typeof CompSaverRouter.current === "function" ? CompSaverRouter.current() : null;
                        return typeof r === "string" ? r : startRoute;
                    }
                });
                // G2, the Host_Call_Gate: the first Comp_Monitor query (Req 8.14, 19.4).
                StartupGate.onHostCalls(function () {
                    if (typeof CompMonitor !== "undefined" && CompMonitor && typeof CompMonitor.refresh === "function") {
                        CompMonitor.refresh("startup");
                    }
                });
            }
            if (lifecycleMode) AppLifecycle.transition("BOOTSTRAPPING");
            startRoute = mountStartViews(startRoute);
            startModule = moduleForRoute(startRoute);
            init();
            switchMainModule(startModule);
            if (typeof CompSaverRouter !== "undefined" && CompSaverRouter && typeof CompSaverRouter.start === "function") {
                CompSaverRouter.start(startRoute, { source: "startup" });
            }
            if (lifecycleMode) AppLifecycle.transition("SHELL_VISIBLE");
            if (views) {
                // Warm paint and the template bindings run in this task, before
                // any evalScript callback (connectDefaultLibrary) can land.
                views.mountSync("templates");
                views.startDeferred();
            }

            if (window.ResizeObserver) {
                var ro = new ResizeObserver(windowResizeFix);
                ro.observe(document.body);
                if (lifecycleMode) AppLifecycle.register("observer", ro, function (observer) { observer.disconnect(); });
            } else if (lifecycleMode) {
                AppLifecycle.listen(window, "resize", windowResizeFix);
            } else {
                window.addEventListener("resize", windowResizeFix);
            }

            function startPing(seconds) {
                if (pingToken) { pingToken.dispose(); pingToken = null; }
                else if (pingInterval) clearInterval(pingInterval);
                pingInterval = setInterval(function () {
                    csInterface.evalScript("compSaverPing()", function (hexResult) {
                        var result = decodeBridge(hexResult);
                        if (result !== "ok") console.warn("[CompSaver] Connection degraded:", result);
                    });
                }, seconds * 1000);
                if (lifecycleMode) pingToken = AppLifecycle.register("timer", pingInterval, clearInterval);
            }
            startPing(Settings.get("performance.pingInterval"));
            var stopPingSettings = Settings.onChange("performance.pingInterval", startPing);
            if (lifecycleMode) AppLifecycle.subscribe(stopPingSettings);

            if (window.FastMedia) {
                if (lifecycleMode) {
                    window.FastMedia.init();
                    AppLifecycle.onDispose(window.FastMedia.dispose);
                } else {
                    setTimeout(function () { window.FastMedia.init(); }, 500);
                }
            }
        } catch (e) {
            if (lifecycleMode) AppLifecycle.transition("DEGRADED");
            console.error("[CompSaver] Initialization error:", e);
            showToast("Init error. Reload panel.", "error");
        }
    }

    window.onload = bootstrapPanel;

    // selectedStaggerMode is declared in core/state.js (shared with resetToolkitStates).

    // =========================================================
    // SEQUENCER CONTROLS - extracted to js/toolkit/toolkit.js
    // (initSequencerControls + steppers; init() calls it)
    // =========================================================

    // initCustomTooltips lives in ui/tooltips.js, loaded before this file.



    // =========================================================
    // CLIPBOARD PASTE - extracted to js/ui/paste.js
    // (initClipboardPaste + handlers; loaded before main.js, global scope)
    // =========================================================

    window.addEventListener("beforeunload", function () {
        if (typeof AppLifecycle !== "undefined") AppLifecycle.dispose("beforeunload");
        if (pingInterval) clearInterval(pingInterval);
        if (typeof clearToast === "function") clearToast();
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        if (_loadTemplatesTimer) clearTimeout(_loadTemplatesTimer);
    });

    // =========================================================
    // updateActiveCompMonitor - extracted to js/ui/comp-monitor.js
    // =========================================================

    // =========================================================
    // COLORFLOW MODULE - extracted to js/toolkit/colorflow.js
    // (loaded before main.js; ColorFlow resolves via global scope)
    // =========================================================

    // ─── Window focus hook: refresh effects grid when panel regains focus ───
    // This catches the case where the user saves via the native AE dialog
    // (which steals focus) and then returns to the panel.
    window.addEventListener("focus", function () {
        if (currentMainModule === MODULES.TOOLKIT) {
            if (currentToolkitSubSection === "effects") {
                loadSavedEffects();
            }
        }
    });


    // =========================================================
    // TEXT ANIMATION MODULE - extracted to js/textanim/textanim.js
    // (var TextAnim IIFE incl. shared preview render pipeline; loaded
    //  before main.js, resolved via global scope. init()/switchToolkit-
    //  SubSection call TextAnim.init()/load().)
    // =========================================================


})();
