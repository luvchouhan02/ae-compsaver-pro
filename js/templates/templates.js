// ============================================================
// templates/templates.js - Templates module (library/render/ops/save)
// ------------------------------------------------------------
// loadTemplates + category system + card/icon rendering + grid event
// delegation + favorite/delete/bulk-delete/rename/move + import +
// the save modal & async save pipeline. Moved verbatim from main.js.
// Fully decoupled: depends only on globals (state, utils, dom, bridge,
// toast, modals, header helpers, TextAnim). init()/switchSection in
// main.js call into these as globals. Loaded before main.js.
// (May later be sub-split into library.js / operations.js / save.js.)
// ============================================================

var _CardView = (typeof TemplateCardView !== "undefined")
    ? TemplateCardView
    : (typeof require === "function" ? (function () { try { return require("./templateCardView.js"); } catch (e) { return null; } })() : null);

var _Actions = (typeof TemplateActions !== "undefined")
    ? TemplateActions
    : (typeof require === "function" ? (function () { try { return require("./templateActions.js"); } catch (e) { return null; } })() : null);

// ── Cold-start section scoping (Requirement 10.3) ──────────────────
// getAllTemplates(rHex, sHex) already filters to one section folder
// (jsx/core.jsx:1200-1226); Wave 2 only supplies the second argument. The map
// is explicit rather than delegated to jsx/core.jsx::normalizeSectionName, so
// an unexpected section degrades to the all-sections scan (activeSectionScanFolder
// returns "") instead of to an empty scoped result.
var SECTION_SCAN_FOLDERS = {
    comp: "comp",
    layer: "layer",
    text: "text",
    text_props: "text",
    footage: "footage",
    effect: "effect",
    icon: "icon",
    overlay: "overlay",
    element: "overlay"
};

function activeSectionScanFolder() {
    var folder = SECTION_SCAN_FOLDERS[currentSection];
    return typeof folder === "string" ? folder : "";
}

function loadTemplates() {
    // Use libraryPaths if available, fallback to rootPath for backward compat
    var pathsToScan = (libraryPaths && libraryPaths.length > 0) ? libraryPaths : (rootPath ? [rootPath] : []);

    if (pathsToScan.length === 0) {
        showToast("Library not connected", "error");
        return;
    }

    // FAST BOOT: Check LibraryIndex cache
    var li = typeof getLibraryIndex === "function" ? getLibraryIndex() : null;

    // 1. Immediate Warm Paint (if we have any entries)
    if (li && li._entries && li._entries.length > 0) {
        if (typeof startupTrace !== "undefined" && startupTrace && typeof startupTrace.noteWarmPaint === "function") {
            startupTrace.noteWarmPaint();
        }
        allTemplates = li._entries;
        for (var k = 0; k < allTemplates.length; k++) {
            if (!allTemplates[k].section) {
                allTemplates[k].section = getTemplateSection(allTemplates[k]);
            }
            // Same bridge as startupWarmPaint: this branch is taken on library
            // path change and manual refresh, and it runs before filterAndRender.
            hydrateWarmPaintThumbnail(allTemplates[k]);
        }
        buildCategoryTabs();
        buildCategoryPanel();
        filterAndRender();
        updateCount();

        // 2. Background Reconciliation
        setTimeout(function () {
            var diskKey = typeof getCombinedDiskValidityKey === "function" ? getCombinedDiskValidityKey(pathsToScan) : null;
            if (li.validityKey === diskKey && !li._needsFullScan) {
                return; // Cache is perfectly valid
            }

            // Stale cache: rescan in the background without blanking the UI.
            // Section-chunked for the same reason as the cold path — one
            // all-sections call here froze the host for the whole library even
            // though the cards were already on screen.
            var bgSession = startupSessionToken();
            var bgPerRoot = [];
            var bgCompleted = 0;
            var bgTotal = pathsToScan.length;
            var bgFailed = false;

            for (var i = 0; i < pathsToScan.length; i++) {
                (function (libPath, rootIndex) {
                    startupScanRootBySection(libPath, bgSession, null, function (flat, failed) {
                        if (!startupSessionValid(bgSession)) return;
                        bgPerRoot[rootIndex] = flat;
                        if (failed === true) bgFailed = true;

                        bgCompleted++;
                        if (bgCompleted !== bgTotal) return;

                        // An incomplete scan is not evidence the library shrank.
                        // Publishing it would drop real templates from both the
                        // grid and the persisted index.
                        if (bgFailed) {
                            if (li) li._needsFullScan = true;
                            return;
                        }

                        var results = [];
                        for (var r = 0; r < bgTotal; r++) {
                            var list = bgPerRoot[r] || [];
                            for (var n = 0; n < list.length; n++) results.push(list[n]);
                        }

                        // Bug C: a stale-cache rescan must not evict media
                        // entries the scan cannot reconstruct. Merge the
                        // surviving index-only media entries back in BEFORE
                        // the wholesale model/index replace below.
                        results = mergeSurvivingMediaEntries(results, allTemplates);

                        allTemplates = results;
                        for (var k = 0; k < allTemplates.length; k++) {
                            allTemplates[k].section = getTemplateSection(allTemplates[k]);
                        }

                        if (li) {
                            li._entries = allTemplates.slice();
                            li.validityKey = diskKey;
                            li._needsFullScan = false;
                            if (typeof saveLibraryIndex === "function") saveLibraryIndex();
                        }

                        buildCategoryTabs();
                        buildCategoryPanel();
                        filterAndRender();
                        updateCount();
                    });
                })(pathsToScan[i], i);
            }
        }, 0);
        return;
    }

    // SLOW BOOT: one section-chunked walk per root.
    //
    // getAllTemplates is ExtendScript, so it runs on After Effects' main thread
    // and blocks the whole application for as long as it walks. Measured on a
    // 326-template library: one all-sections call blocks for 74 s, while a
    // single-section call costs ~30 ms of fixed overhead plus the section's own
    // templates. Splitting the walk into one call per section therefore costs
    // ~200 ms in extra round trips and hands the host back between every
    // section, and putting the ACTIVE section first means the cards the user is
    // looking at arrive in that section's time alone, not the library's.
    showStartupLoadingState();

    var scanSession = startupSessionToken();
    var perRoot = [];
    var seen = [];
    var painted = 0;
    var completed = 0;
    var total = pathsToScan.length;
    var anyFailed = false;

    for (var i = 0; i < pathsToScan.length; i++) {
        (function (libPath, rootIndex) {
            startupScanRootBySection(libPath, scanSession, function (records) {
                // Progressive paint from everything that has landed so far. The
                // grid is only ever added to here — never cleared — so cards
                // stay put while the remaining sections arrive.
                if (!records || records.length === 0) return;
                for (var s = 0; s < records.length; s++) {
                    records[s].section = getTemplateSection(records[s]);
                    seen.push(records[s]);
                }
                var matching = filterStartupRecordsFrom(seen);
                if (matching.length > painted) {
                    if (painted === 0) painted = renderCardsFirstBatch(matching);
                    else painted += appendCardBatch(matching, painted, matching.length - painted);
                    updateCount();
                }
            }, function (flat, failed) {
                if (!startupSessionValid(scanSession)) return;
                perRoot[rootIndex] = flat;
                if (failed === true) anyFailed = true;

                completed++;
                if (completed !== total) return;

                var results = [];
                for (var r = 0; r < total; r++) {
                    var list = perRoot[r] || [];
                    for (var n = 0; n < list.length; n++) results.push(list[n]);
                }

                // Bug C: same merge-before-replace as the warm path — any
                // media entries still held by the index (or the live model)
                // survive the cold-boot scan instead of being evicted.
                results = mergeSurvivingMediaEntries(results, li && li._entries ? li._entries : allTemplates);

                allTemplates = results;
                for (var k = 0; k < allTemplates.length; k++) {
                    allTemplates[k].section = getTemplateSection(allTemplates[k]);
                }

                // Only fill the cache from a scan that actually succeeded. A
                // section whose response failed to parse yields an empty list,
                // and persisting that would replace a good index with a partial
                // one — the next launch would then warm paint a truncated
                // library. A failed scan leaves the previous index alone and
                // raises the rescan flag instead.
                if (li) {
                    if (anyFailed) {
                        li._needsFullScan = true;
                    } else {
                        var diskKey = typeof getCombinedDiskValidityKey === "function" ? getCombinedDiskValidityKey(pathsToScan) : null;
                        li._entries = allTemplates.slice();
                        li.validityKey = diskKey;
                        li._needsFullScan = false;
                        if (typeof saveLibraryIndex === "function") saveLibraryIndex();
                    }
                }

                buildCategoryTabs();
                buildCategoryPanel();
                filterAndRender();
                updateCount();

                // Obsidian startup gates (decision (h)): an empty library never
                // produces a first card, so the settled cold scan reports its
                // template count and a count of 0 opens G1 and G2.
                if (typeof PerfEvents !== "undefined" && PerfEvents && typeof PerfEvents.emit === "function") {
                    PerfEvents.emit("templates.cold-scan.complete", { templateCount: allTemplates.length });
                }
            });
        })(pathsToScan[i], i);
    }
}

// The seven section folders ExtendScript walks when no sHex filter is given
// (jsx/core.jsx:1223). This exact order is the record order one all-sections
// call produces, and the accumulated result is flattened back into it, so a
// chunked scan is byte-identical to the single call it replaces.
//
// D6 — why seven folders is COMPLETE, and why "element" must NOT be added.
// This list covers the whole library only because of a bidirectional alias on
// the host side: an "overlay"-filtered getAllTemplates call is expanded there
// to BOTH the overlay and element folders, and records scanned out of the
// element alias folder are normalized back to the canonical "overlay" section
// before they are returned. So element/ assets already arrive under overlay,
// exactly once, from the single "overlay" chunk this list issues.
//
// Adding "element" here would therefore issue TWO chunks that each return BOTH
// folders, duplicating every overlay and every element record in the flattened
// result and in the persisted index. That is a data defect, not a widening, and
// it is why BUG 6 was recorded as NOT REPRODUCING and no entry was added here.
//
// If a future change removes that host-side expansion, element/ assets stop
// being scanned at all — and THIS list is the correct place to fix it, by
// adding "element" and flattening it into the fixed order above.
var STARTUP_SCAN_SECTIONS = ["comp", "layer", "text", "footage", "effect", "icon", "overlay"];

// Scan order: the active section first so the visible grid fills in that
// section's time, then the remainder in the fixed order.
function startupScanSectionOrder() {
    var active = typeof activeSectionScanFolder === "function" ? activeSectionScanFolder() : "";
    var order = [];
    if (typeof active === "string" && active !== "") order.push(active);
    for (var i = 0; i < STARTUP_SCAN_SECTIONS.length; i++) {
        if (STARTUP_SCAN_SECTIONS[i] !== active) order.push(STARTUP_SCAN_SECTIONS[i]);
    }
    return order;
}

// One root, one sequential bridge call per section. Each evalScript callback has
// already returned control to the panel, so chaining the next call from inside
// it IS the yield that lets After Effects service its own event loop.
//
// onSection(records, sectionFolder) fires per arrival for progressive painting.
// onDone(flatRecords, failed) fires once every section has landed, with records
// flattened back into the fixed section order. `failed` is true when any section
// response could not be parsed, so callers can refuse to persist a partial set.
// Every callback is session-guarded: a disposed or superseded context stops the
// chain rather than mutating state.
function startupScanRootBySection(scanRoot, token, onSection, onDone) {
    var order = startupScanSectionOrder();
    var slots = [];
    var at = 0;
    var failed = false;

    var bridgeReady = typeof csInterface !== "undefined" && csInterface &&
        typeof csInterface.evalScript === "function" && typeof encodeBridge === "function";
    if (!bridgeReady) {
        if (typeof onDone === "function") onDone([], true);
        return;
    }

    function finish() {
        var flat = [];
        for (var i = 0; i < STARTUP_SCAN_SECTIONS.length; i++) {
            var slot = slots[i];
            if (!slot) continue;
            for (var j = 0; j < slot.length; j++) flat.push(slot[j]);
        }
        if (typeof onDone === "function") onDone(flat, failed);
    }

    function next() {
        if (!startupSessionValid(token)) return;
        if (at >= order.length) { finish(); return; }

        var sectionFolder = order[at];
        at++;
        var slot = STARTUP_SCAN_SECTIONS.indexOf(sectionFolder);

        var phase = startupTracePhase("startup.section-scan");
        csTraceBridgeScan(scanRoot);
        csInterface.evalScript(
            'getAllTemplates("' + encodeBridge(scanRoot) + '","' + encodeBridge(sectionFolder) + '")',
            function (hexData) {
                if (!startupSessionValid(token)) return;
                startupPhaseEnd(phase, { root: scanRoot, section: sectionFolder });

                var records = [];
                var parsed = false;
                if (hexData) {
                    var data = typeof decodeBridge === "function" ? decodeBridge(hexData) : null;
                    try {
                        records = JSON.parse(data || "[]");
                        parsed = true;
                    } catch (eP) {
                        records = [];
                        console.error("[CompSaver] Failed to parse templates from: " + scanRoot, eP);
                    }
                } else {
                    // No response at all: the host did not answer for this
                    // section, so the set is incomplete rather than empty.
                    failed = true;
                }
                if (hexData && !parsed) failed = true;
                if (!records || typeof records.length !== "number") records = [];

                for (var j = 0; j < records.length; j++) records[j].sourcePath = scanRoot;
                if (slot >= 0) slots[slot] = records;

                try {
                    if (typeof onSection === "function") onSection(records, sectionFolder);
                } catch (eS) {
                    startupTraceCall("markUnavailable", "startup.section-scan", String(eS));
                }

                next();
            }
        );
    }

    next();
}

function hasCatalog() { return typeof TemplateCatalog !== "undefined"; }
function hasVGrid() { return typeof VirtualGrid !== "undefined" && typeof TemplateCatalog !== "undefined"; }

function getSectionTemplates() {
    if (!hasCatalog()) {
        // Fallback (module not loaded): the original full scan.
        var outOld = [];
        for (var o = 0; o < allTemplates.length; o++) {
            if (getTemplateSection(allTemplates[o]) === currentSection) outOld.push(allTemplates[o]);
        }
        return outOld;
    }
    // Catalog-backed: ordered record list without rescanning allTemplates.
    var out = [];
    var ids = TemplateCatalog.idsFor(currentSection, "All", "");
    for (var i = 0; i < ids.length; i++) {
        var t = TemplateCatalog.get(ids[i]);
        if (t) out.push(t);
    }
    return out;
}

function getSectionCategories(sectionTemplates) {
    if (!hasCatalog()) {
        var catsOld = ["All", "Favorites"];
        for (var o = 0; o < sectionTemplates.length; o++) {
            var cOld = sectionTemplates[o].category;
            if (cOld && catsOld.indexOf(cOld) === -1) catsOld.push(cOld);
        }
        return catsOld;
    }
    // One catalog lookup instead of repeated array indexOf scans. The
    // catalog preserves first-discovery order, matching the previous
    // rescan-based category list exactly.
    return TemplateCatalog.categories(currentSection);
}

function getPinnedCategories() {
    var arr = Settings.get("ui.pinnedCategories");
    return Array.isArray(arr) ? arr : [];
}

function savePinnedCategories(arr) {
    Settings.set("ui.pinnedCategories", arr || []);
}

function togglePinCategory(cat, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    var pinned = getPinnedCategories();
    var idx = pinned.indexOf(cat);
    if (idx === -1) {
        pinned.push(cat);
    } else {
        pinned.splice(idx, 1);
    }
    savePinnedCategories(pinned);
    buildCategoryTabs();
    buildCategoryPanel();
}

function isShowAllInline() {
    return Settings.get("ui.showAllCategoriesInline");
}

function saveShowAllInline(val) {
    Settings.set("ui.showAllCategoriesInline", !!val);
}

function buildCategoryTabs() {
    ensureCatalogFresh();
    var sectionTemplates = getSectionTemplates();
    var cats = getSectionCategories(sectionTemplates);
    updateCustomSelect(cats);

    var tabsArea = DOM["category-tabs"];
    var moreBtn = DOM["btn-more-cats"];
    if (!tabsArea) return;
    tabsArea.innerHTML = "";

    var activeName = currentCategory;
    var showAll = isShowAllInline();
    var pinned = getPinnedCategories();

    var catsToShow = [];
    if (showAll) {
        catsToShow = cats;
    } else {
        catsToShow = ["All", "Favorites"];
        for (var i = 0; i < pinned.length; i++) {
            if (cats.indexOf(pinned[i]) !== -1 && catsToShow.indexOf(pinned[i]) === -1) {
                catsToShow.push(pinned[i]);
            }
        }
        // Always ensure the active category is visible in the tab bar
        if (activeName && catsToShow.indexOf(activeName) === -1 && cats.indexOf(activeName) !== -1) {
            catsToShow.push(activeName);
        }
    }

    for (var i = 0; i < catsToShow.length; i++) {
        (function (cat) {
            var label = cat;
            if (cat === "Favorites") {
                label = "G\u2605 Fav";
            } else if (cat === "Uncategorized") {
                label = "Uncat";
            }
            var btn = document.createElement("button");
            btn.className = "cat-pill" + (cat === activeName ? " active" : "");
            btn.dataset.cat = cat;
            btn.textContent = label;
            btn.title = cat;
            btn.addEventListener("click", function () {
                setCategory(cat);
                closeCatPanel();
                btn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
            });
            tabsArea.appendChild(btn);
        })(catsToShow[i]);
    }

    if (moreBtn) {
        moreBtn.removeAttribute("data-overflow");
        moreBtn.title = "Categories List";
    }

    // Scroll active tab into view asynchronously
    setTimeout(function () {
        var activeBtn = tabsArea.querySelector(".cat-pill.active");
        if (activeBtn) {
            activeBtn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
        }
    }, 50);
}

function buildCategoryPanel() {
    var sectionTemplates = getSectionTemplates();
    var cats = getSectionCategories(sectionTemplates);
    var cCounts = hasCatalog() ? TemplateCatalog.sectionCounts(currentSection) : null;
    var list = DOM["cat-panel-list"];
    if (!list) return;
    list.innerHTML = "";

    var chk = DOM["chk-show-all-cats"];
    if (chk) {
        chk.checked = isShowAllInline();
    }

    var pinned = getPinnedCategories();

    for (var i = 0; i < cats.length; i++) {
        (function (cat) {
            var count;
            if (cat === "All") {
                count = cCounts ? cCounts.all : sectionTemplates.length;
            } else if (cat === "Favorites") {
                if (cCounts) {
                    count = cCounts.favorites;
                } else {
                    count = 0;
                    for (var j = 0; j < sectionTemplates.length; j++) {
                        if (sectionTemplates[j].favorite) count++;
                    }
                }
            } else {
                if (cCounts) {
                    count = cCounts.cats[cat] || 0;
                } else {
                    count = 0;
                    for (var k = 0; k < sectionTemplates.length; k++) {
                        if (sectionTemplates[k].category === cat) count++;
                    }
                }
            }

            var item = document.createElement("div");
            item.className = "cat-panel-item" + (currentCategory === cat ? " active" : "");
            item.dataset.cat = cat;

            var isPinned = pinned.indexOf(cat) !== -1;
            var pinHTML = "";
            if (cat !== "All" && cat !== "Favorites") {
                pinHTML =
                    '<button class="btn-cat-pin' + (isPinned ? ' pinned' : '') + '" title="' + (isPinned ? 'Unpin category' : 'Pin category') + '">' +
                    '<svg width="10" height="10" viewBox="0 0 24 24" fill="' + (isPinned ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2">' +
                    '<path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z" />' +
                    '<circle cx="12" cy="10" r="2.5" />' +
                    '</svg>' +
                    '</button>';
            }

            item.innerHTML =
                (cat === "Favorites" ? "★ " : "") +
                escapeHTML(cat) +
                pinHTML +
                '<span class="cat-count">' + count + "</span>";

            item.addEventListener("click", function () {
                setCategory(cat);
                closeCatPanel();
            });

            var pinBtn = item.querySelector(".btn-cat-pin");
            if (pinBtn) {
                pinBtn.addEventListener("click", function (e) {
                    togglePinCategory(cat, e);
                });
            }

            list.appendChild(item);
        })(cats[i]);
    }
}

// Update the already-mounted category pills and panel rows for a new active
// category: active classes + counts only, no tab/panel rebuild, no record
// scans. Rare fallback: when the target has no pill in the tab bar (not
// pinned and not inline), one rebuild keeps the old visibility behavior.
function updateCategoryActiveStates(cat) {
    var tabsArea = DOM["category-tabs"];
    var list = DOM["cat-panel-list"];

    var hasPill = false;
    if (tabsArea) {
        var pills = tabsArea.querySelectorAll(".cat-pill");
        for (var i = 0; i < pills.length; i++) {
            var on = pills[i].dataset.cat === cat;
            if (on) hasPill = true;
            if (on) pills[i].classList.add("active");
            else pills[i].classList.remove("active");
        }
    }
    if (!hasPill) {
        buildCategoryTabs();
    }

    if (list) {
        var cCounts = TemplateCatalog.sectionCounts(currentSection);
        var rows = list.querySelectorAll(".cat-panel-item");
        for (var r = 0; r < rows.length; r++) {
            var rowCat = rows[r].dataset.cat;
            if (rowCat === cat) rows[r].classList.add("active");
            else rows[r].classList.remove("active");
            var n = rowCat === "All" ? cCounts.all :
                rowCat === "Favorites" ? cCounts.favorites :
                    (cCounts.cats[rowCat] || 0);
            var badge = rows[r].querySelector(".cat-count");
            if (badge) badge.textContent = String(n);
        }
    }
}

function setCategory(cat) {
    currentCategory = cat;
    if (hasVGrid()) {
        updateCategoryActiveStates(cat);
    } else {
        buildCategoryTabs();
        buildCategoryPanel();
    }
    filterAndRender();
}

function filterAndRender() {
    var sb = DOM["search-box"];
    var sv = sb ? sb.value.toLowerCase().trim() : "";

    if (!hasCatalog()) {
        // Fallback (module not loaded): the original scan + full render.
        var section = getSectionTemplates();
        var filtered = [];
        for (var i = 0; i < section.length; i++) {
            var t = section[i];
            if (currentCategory === "Favorites" && !t.favorite) continue;
            if (currentCategory !== "All" && currentCategory !== "Favorites" &&
                t.category !== currentCategory) continue;
            if (sv) {
                var hay = ((t.name || "") + " " + (t.category || "") + " " +
                    (t.type || "") + " " + (t.section || "") + " " +
                    (t.dim || "")).toLowerCase();
                if (hay.indexOf(sv) === -1) continue;
            }
            filtered.push(t);
        }
        renderCards(filtered);
        return;
    }

    ensureCatalogFresh();
    var ids = TemplateCatalog.idsFor(currentSection, currentCategory, sv);

    // Windowed render: mounted cards bounded to viewport+overscan. The paint
    // is versioned, so a superseded search/category result never lands late.
    renderWindowedIds(ids, {
        section: currentSection,
        listKey: currentSection + "|" + currentCategory + "|" + sv,
        restoreScroll: true
    });
}

// ── Catalog freshness ──────────────────────────────────────────────
// O(1) when fresh: rebuilds the catalog only when a population path changed
// `allTemplates` without going through the incremental UI mutation helpers.
//
// `TemplateCatalog.size() !== allTemplates.length` used to be the ONLY test,
// and a length delta is exactly what the two mutation classes that matter most
// do not produce:
//   1. In-place field writes on an existing record (the reconcile field copy,
//      a thumbnail completion/failure) keep both the count and every object
//      identity, so the catalog's own copy of the record silently diverges when
//      it is a clone rather than the same object.
//   2. MediaEntryRepository._publishDurable (js/core/persistence.js) clears the
//      shared `allTemplates` mirror and re-pushes fresh CLONES — every element
//      replaced at CONSTANT length. The media insert commit grows the array by
//      one (so a rebuild happened by luck), but the COMPLETION patchById does
//      not, so the catalog kept pre-completion clones whose `thumbnail` was ""
//      and virtualGrid — which renders from TemplateCatalog.get — showed a
//      blank card for the rest of the session.
// Detection is O(1) and stays off the rebuild path when nothing moved: a
// revision counter every panel-side mutation bumps (case 1, which changes no
// observable array shape at all), plus an array/length/first/last identity probe
// that catches a wholesale rewrite performed OUTSIDE this file (case 2, which
// this file never sees and therefore cannot count).
var _catalogBuilt = false;
var _templatesRevision = 0;   // bumped by every in-place / wholesale model change
var _catalogSyncRef = null;   // allTemplates array identity at the last sync
var _catalogSyncLen = -1;
var _catalogSyncFirst = null; // element identity probes (clone rewrites move these)
var _catalogSyncLast = null;

// Bump the model revision. Every mutation of `allTemplates` that is NOT
// mirrored into the catalog through TemplateCatalog.patch/remove funnels
// through here, so the next ensureCatalogFresh rebuilds.
function markTemplatesDirty() {
    _templatesRevision++;
    return _templatesRevision;
}

// Record the model shape the catalog is currently in sync with. O(1).
function noteCatalogSynced() {
    var list = (typeof allTemplates !== "undefined" && allTemplates) ? allTemplates : null;
    if (typeof TemplateCatalog !== "undefined" && TemplateCatalog.stampSource) {
        TemplateCatalog.stampSource(_templatesRevision);
    }
    _catalogSyncRef = list;
    _catalogSyncLen = list ? list.length : -1;
    _catalogSyncFirst = (list && list.length) ? list[0] : null;
    _catalogSyncLast = (list && list.length) ? list[list.length - 1] : null;
}

// True when `allTemplates` changed in a way the catalog has not absorbed.
function catalogSourceChanged() {
    if (typeof TemplateCatalog === "undefined") return false;
    if (!TemplateCatalog.sourceStamp || TemplateCatalog.sourceStamp() !== _templatesRevision) return true;
    if (_catalogSyncRef !== allTemplates) return true;
    var len = allTemplates ? allTemplates.length : 0;
    if (_catalogSyncLen !== len) return true;
    if (len > 0 && (_catalogSyncFirst !== allTemplates[0] || _catalogSyncLast !== allTemplates[len - 1])) return true;
    // Retained from the original test: a count mismatch is still a rebuild
    // trigger, so nothing that used to be detected stops being detected.
    return TemplateCatalog.size() !== len;
}

function ensureCatalogFresh() {
    if (typeof TemplateCatalog === "undefined") return;
    if (!_catalogBuilt || catalogSourceChanged()) {
        TemplateCatalog.build(allTemplates, getTemplateSection, _templatesRevision);
        _catalogBuilt = true;
        noteCatalogSynced();
    }
}

// Shared windowed renderer for selection results and full-list callers.
// Empty lists reuse the existing per-section empty state byte-for-byte.
function renderWindowedIds(ids, options) {
    ensureCatalogFresh();
    var gridId = resolveSectionGridId();
    var grid = document.getElementById(gridId);

    if (!grid || !ids || ids.length === 0 || !hasVGrid()) {
        if (grid) renderCards([]);
        return;
    }

    VirtualGrid.render(gridId, grid, options.listKey || (gridId + "|" + Date.now()), ids, {
        section: options.section,
        selectedKeys: tmpBulkSelected,
        restoreScroll: !!options.restoreScroll,
        onPainted: function (mountedGrid) {
            attachSectionHoverPreviews(mountedGrid);
        }
    });
}

// Resync the windowed grid with the catalog for the view that is on screen
// right now, keeping the user's scroll offset.
//
// The media import path does NOT go through this renderer: it appends its
// optimistic cards straight into the grid via KeyedMediaCardHelper so a card
// shows up the instant a file is accepted. VirtualGrid, though, repaints by
// replacing the grid's children and sizes its spacers from ITS OWN id list — so
// after an import the first scroll deleted every directly-inserted card and
// laid out the scroll height for the pre-import list. The user saw the first
// screenful of templates and blank space below, while search and category
// switch (which rebuild the ids from TemplateCatalog here) showed all of them.
//
// This is the reconciliation the media engine calls after it mutates the model
// (js/core/fastMediaEngine.js gridRefresh). Same view => resync in place, which
// keeps the offset; different view => a normal windowed render.
function syncSectionGridWindow() {
    if (!hasCatalog() || !hasVGrid()) return false;
    var gridId = resolveSectionGridId();
    if (!document.getElementById(gridId)) return false;

    ensureCatalogFresh();
    var sb = DOM["search-box"];
    var sv = sb ? sb.value.toLowerCase().trim() : "";
    var listKey = currentSection + "|" + currentCategory + "|" + sv;
    var ids = TemplateCatalog.idsFor(currentSection, currentCategory, sv);

    if (ids.length && typeof VirtualGrid.sync === "function" &&
        typeof VirtualGrid.listKeyOf === "function" && VirtualGrid.listKeyOf(gridId) === listKey) {
        var synced = VirtualGrid.sync(gridId, ids, {
            section: currentSection,
            selectedKeys: tmpBulkSelected,
            onPainted: function (mountedGrid) {
                attachSectionHoverPreviews(mountedGrid);
            }
        });
        if (synced) return true;
    }

    renderWindowedIds(ids, { section: currentSection, listKey: listKey, restoreScroll: true });
    return true;
}

// Attribute-escape a complete card attribute value. Escaping ampersands first is
// required so an ID containing entity-like text parses back to the exact value.
function escapeTemplateCardAttribute(value) {
    if (_CardView && typeof _CardView.escapeTemplateCardAttribute === "function") {
        return _CardView.escapeTemplateCardAttribute(value);
    }
    return ("" + (value === undefined || value === null ? "" : value))
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// Side-effect-free single-card markup shared by the generic renderer and the
// media-only keyed adapter. Keep the existing classes/data attributes intact.
function renderTemplateCardMarkup(t, section, selectedKeys) {
    if (_CardView && typeof _CardView.renderTemplateCardMarkup === "function") {
        return _CardView.renderTemplateCardMarkup(t, section, selectedKeys);
    }
    t = t || {};
    selectedKeys = selectedKeys || [];

    var COL_FAV_OFF = "rgba(255,255,255,0.55)";
    var COL_FAV_ON = "#fbbf24";
    var thumbSrc = t.thumbnail ? ("" + t.thumbnail).replace(/\\/g, "/") : "";
    if (thumbSrc && !/^file:\/\/\//i.test(thumbSrc)) {
        var thumbFwd = thumbSrc;
        if (thumbFwd.charAt(0) === "/") thumbFwd = thumbFwd.substring(1);
        thumbSrc = "file:///" + encodeURI(thumbFwd);
    }

    var isFav = !!t.favorite;
    var absMediaPath = ("" + (t.proxyFile || t.mediaFile || "")).replace(/\\/g, "/");
    if (absMediaPath && absMediaPath.indexOf(":/") === -1 && absMediaPath.indexOf(":\\") === -1 && t.folderPath) {
        absMediaPath = ("" + t.folderPath).replace(/\\/g, "/") + "/" + absMediaPath;
    }

    var previewUrlAttr = "";
    if (t.previewPath) {
        var previewFwd = ("" + t.previewPath).replace(/\\/g, "/");
        if (previewFwd.charAt(0) === "/") previewFwd = previewFwd.substring(1);
        var previewUrl = "file:///" + encodeURI(previewFwd) + "?v=" + (t.previewMtime || Date.now());
        previewUrlAttr = ' data-preview="' + escapeAttr(previewUrl) + '"';
    }

    var thumbHTML;
    if (thumbSrc) {
        thumbHTML = '<img class="thumb-img" src="' + escapeAttr(thumbSrc) + '" alt="">';
    } else if (t.type === "media") {
        // Media cards always retain one stable patch target, including while
        // their optimistic thumbnail is pending.
        thumbHTML = '<img class="thumb-img" alt="">';
    } else if (section === SECTIONS.EFFECT) {
        thumbHTML =
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"' +
            ' stroke="rgba(79,140,255,0.4)" stroke-width="1.5" stroke-linejoin="round">' +
            '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>';
    } else {
        thumbHTML =
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"' +
            ' stroke="rgba(79,140,255,0.15)" stroke-width="1.5">' +
            '<rect x="3" y="3" width="18" height="18" rx="3"/></svg>';
    }

    var hoverButtonsHTML =
        '<button type="button" class="btn-more card-btn-more" title="More">' +
        '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
        ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>' +
        '</svg></button>';
    var favHTML =
        '<button class="btn-favorite' + (isFav ? " active" : "") + '" data-tooltip="">' +
        '<svg width="11" height="11" viewBox="0 0 24 24"' +
        ' fill="' + (isFav ? COL_FAV_ON : "none") + '"' +
        ' stroke="' + (isFav ? COL_FAV_ON : COL_FAV_OFF) + '" stroke-width="2">' +
        '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>' +
        '</svg></button>';

    var cardKey = t.name + "||" + t.category;
    var isSel = selectedKeys.indexOf(cardKey) !== -1 ? " selected-for-delete" : "";
    var isPending = t._isPending ? " media-pending" : "";
    var stableDomId = "tpl-" + (t.id === undefined || t.id === null ? "" : "" + t.id);

    return '<div class="card' + (isFav ? " is-fav" : "") + isSel + isPending + '"' +
        ' style="content-visibility: auto; contain-intrinsic-size: 100% 160px;"' +
        ' id="' + escapeTemplateCardAttribute(stableDomId) + '"' +
        ' title="' + escapeAttr(t.name) + '"' +
        ' data-file="' + escapeAttr(t.name) + '"' +
        ' data-cat="' + escapeAttr(t.category) + '"' +
        ' data-folder="' + escapeAttr((t.folderPath || "").replace(/\\/g, "/")) + '"' +
        ' data-thumb="' + escapeAttr(thumbSrc) + '"' +
        (t.type === "media" ? ' data-type="media" data-mediatype="' + escapeAttr(t.mediaType) + '" data-mediapath="' + escapeAttr(absMediaPath) + '"' : "") +
        previewUrlAttr + '>' +
        '<div class="card-check">' +
        '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
        '</div>' + favHTML + hoverButtonsHTML +
        '<div class="thumb-box">' + thumbHTML + '</div>' +
        '<div class="card-name">' + escapeHTML(t.name) + '</div>' +
        '</div>';
}

// ── Startup render primitives (bounded first pass) ─────────────────
// TEMPLATE_FIRST_BATCH is the fixed First_Batch source constant (Req 3.1):
// no Settings key, no viewport measurement, no scroll windowing.
var TEMPLATE_FIRST_BATCH = 60;
var TEMPLATE_APPEND_BATCH = 60;

// Single source of truth for the active Card_Grid id. Extracted verbatim from
// the head of renderCards so the bounded renderer and the full renderer can
// never disagree about the target grid.
function resolveSectionGridId() {
    var gridId = "comp-list-container";
    if (currentSection === SECTIONS.LAYER) gridId = "transition-list-container";
    else if (isTextSection(currentSection)) gridId = "text-list-container";
    else if (currentSection === SECTIONS.FOOTAGE) gridId = "footage-list-container";
    else if (currentSection === SECTIONS.EFFECT) gridId = "effect-list-container";
    else if (isImageSection(currentSection)) gridId = "icon-list-container";
    return gridId;
}

// The same section condition renderCards uses to attach hover previews.
function sectionUsesHoverPreviews() {
    return true;
}

// Re-attachment is safe: the listeners are the same module-level function
// references, so addEventListener de-duplicates.
function attachSectionHoverPreviews(grid) {
    if (!grid) return;
    if (!sectionUsesHoverPreviews()) return;
    if (typeof TextAnim === "undefined" || !TextAnim || typeof TextAnim.attachHoverPreviews !== "function") return;
    try {
        TextAnim.attachHoverPreviews(grid);
    } catch (eH) {
        console.error("[CompSaver] attachHoverPreviews failed:", eH);
    }
}

// First bounded paint: at most TEMPLATE_FIRST_BATCH cards, one innerHTML write.
// Returns the number of cards painted. Delegates to renderCards for the empty
// set so the existing per-category empty state is reused byte-for-byte.
function renderCardsFirstBatch(records) {
    if (_CardView && typeof _CardView.renderCardsFirstBatch === "function") {
        return _CardView.renderCardsFirstBatch(records);
    }
    if (!records || typeof records.length !== "number") return 0;
    if (records.length === 0) {
        renderCards(records);
        return 0;
    }

    var grid = document.getElementById(resolveSectionGridId());
    if (!grid) return 0;

    var count = records.length < TEMPLATE_FIRST_BATCH ? records.length : TEMPLATE_FIRST_BATCH;
    var html = [];
    for (var i = 0; i < count; i++) {
        html.push(renderTemplateCardMarkup(records[i], currentSection, tmpBulkSelected));
    }

    grid.innerHTML = html.join("");
    attachSectionHoverPreviews(grid);
    return count;
}

// Appends records[from .. from+count-1] without ever clearing the grid.
// Returns the number of cards appended.
function appendCardBatch(records, from, count) {
    if (_CardView && typeof _CardView.appendCardBatch === "function") {
        return _CardView.appendCardBatch(records, from, count);
    }
    if (!records || typeof records.length !== "number") return 0;

    var start = (typeof from === "number" && from > 0) ? from : 0;
    if (start >= records.length) return 0;

    var want = (typeof count === "number" && count > 0) ? count : TEMPLATE_APPEND_BATCH;
    var end = start + want;
    if (end > records.length) end = records.length;
    if (end <= start) return 0;

    var grid = document.getElementById(resolveSectionGridId());
    if (!grid) return 0;
    if (typeof grid.insertAdjacentHTML !== "function") return 0;

    var html = [];
    for (var i = start; i < end; i++) {
        html.push(renderTemplateCardMarkup(records[i], currentSection, tmpBulkSelected));
    }

    grid.insertAdjacentHTML("beforeend", html.join(""));
    attachSectionHoverPreviews(grid);
    return end - start;
}

// Shared cs-empty-state markup (base.css §2.2) used while the cold path loads.
// Writes only into an empty active grid; never overwrites painted cards.
function showStartupLoadingState() {
    var grid = document.getElementById(resolveSectionGridId());
    if (!grid) return;

    var existing = typeof grid.innerHTML === "string" ? grid.innerHTML : "";
    if (existing.replace(/\s+/g, "") !== "") return;

    grid.innerHTML =
        '<div class="tpl-empty-state cs-empty-state">' +
        '<span class="cs-empty-state__icon" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg>' +
        "</span>" +
        '<p class="cs-empty-state__title">Loading library…</p>' +
        '<p class="cs-empty-state__text">Reading your saved library</p></div>';
}

// ── Startup warm paint, session guards, deferred queue ─────────────
// Startup state. Neither object is persisted.
//   _warmPaintServedPaths — joined path list served by warm paint, else null.
//   _startupPending       — the single in-flight deferred-work record.
var _warmPaintServedPaths = null;
var _startupPending = null;

// Session guards. The owner (CSStartupSession) lives in main.js and is
// published on window; templates.js reads it through typeof probes so this
// module stays runnable in the vm suites that load templates.js alone.
// A null/absent owner means "no owner" and is treated as valid.
function startupSessionToken() {
    var s = (typeof CSStartupSession !== "undefined") ? CSStartupSession : null;
    return (s && typeof s.generation === "number") ? s.generation : null;
}

function startupSessionValid(token) {
    if (token === null || token === undefined) return true;
    var s = (typeof CSStartupSession !== "undefined") ? CSStartupSession : null;
    if (!s || typeof s.generation !== "number") return true;
    return s.active === true && s.generation === token;
}

// Trace access is read-only and fully guarded: no arithmetic on trace values
// ever happens here, all timing math lives in observability.js.
function startupTraceRef() {
    if (typeof PerfEvents === "undefined" || !PerfEvents) return null;
    if (typeof PerfEvents.startupTrace !== "function") return null;
    var t = null;
    try {
        t = PerfEvents.startupTrace();
    } catch (eT) {
        return null;
    }
    return t ? t : null;
}

function startupTraceCall(method, a, b, c) {
    var t = startupTraceRef();
    if (!t || typeof t[method] !== "function") return;
    try {
        t[method](a, b, c);
    } catch (eC) { }
}

// Guarded bridge-scan counter used by loadTemplates before each evalScript.
// Wrapped in try/catch on top of the already-guarded startupTraceCall so a
// missing or throwing trace can never affect the scan itself.
function csTraceBridgeScan(root) {
    try {
        startupTraceCall("countBridgeScan", root);
    } catch (eB) { }
}

// Guarded Root_Generation bump for CompSaver's own mutations (Requirement 8.3).
// Invalidation through the manifest is best-effort by design: Root_Signature is
// the correctness backstop, so a missed bump only costs a background reconcile.
// That is why every failure — an absent persistence helper, a falsy root, a
// throwing write — is swallowed here rather than surfaced to the mutation.
function csBumpRootGeneration(root) {
    try {
        if (typeof bumpRootGeneration !== "function") return;
        if (!root || typeof root !== "string") return;
        bumpRootGeneration(root);
    } catch (eG) { }
}

// finalRerender has no recorder method: the report object published by
// observability.js is the live record, so the flag is set on it directly.
function startupTraceMarkFinalRerender() {
    var t = startupTraceRef();
    if (!t || typeof t.report !== "function") return;
    try {
        var r = t.report();
        if (r) r.finalRerender = true;
    } catch (eF) { }
}

function startupTracePhase(name) {
    var t = startupTraceRef();
    if (!t || typeof t.beginPhase !== "function") return null;
    try {
        var p = t.beginPhase(name);
        return (p && typeof p.end === "function") ? p : null;
    } catch (eP) {
        return null;
    }
}

function startupPhaseEnd(phase, fields) {
    if (!phase || typeof phase.end !== "function") return;
    try {
        phase.end(fields);
    } catch (eE) { }
}

// The load reason recorded by loadLibraryIndex (absent / index-empty /
// corrupt / no-index-object). Falls back to the neutral empty reason.
function startupIndexReason() {
    if (typeof getLastLibraryIndexLoadReason !== "function") return "index-empty";
    var reason = null;
    try {
        reason = getLastLibraryIndexLoadReason();
    } catch (eR) {
        return "index-empty";
    }
    return (typeof reason === "string" && reason) ? reason : "index-empty";
}

// libraryPaths, else rootPath, else nothing. Length is validated before any
// comparison so an inert host value can never be used arithmetically.
function resolveStartupPaths() {
    var paths = [];
    var lp = (typeof libraryPaths !== "undefined") ? libraryPaths : null;
    if (lp && typeof lp.length === "number" && lp.length > 0) {
        for (var i = 0; i < lp.length; i++) paths.push(lp[i]);
        return paths;
    }
    var rp = (typeof rootPath !== "undefined") ? rootPath : null;
    if (rp && typeof rp === "string") paths.push(rp);
    return paths;
}

// The same section/category/search predicate filterAndRender applies, so the
// batched startup output and a later filterAndRender can never disagree.
function filterStartupRecords() {
    return filterStartupRecordsFrom(allTemplates);
}

// The same predicate over an explicit record set, so the cold path's scoped
// accumulator is filtered exactly like allTemplates is. Input order is
// preserved, which is what lets phase A append from the already-painted index.
function filterStartupRecordsFrom(records) {
    var sb = (typeof DOM !== "undefined" && DOM) ? DOM["search-box"] : null;
    var sv = (sb && typeof sb.value === "string") ? sb.value.toLowerCase().trim() : "";

    var source = (records && typeof records.length === "number") ? records : [];
    var section = [];
    for (var s = 0; s < source.length; s++) {
        if (getTemplateSection(source[s]) === currentSection) section.push(source[s]);
    }

    var filtered = [];
    for (var i = 0; i < section.length; i++) {
        var t = section[i];
        if (currentCategory === "Favorites" && !t.favorite) continue;
        if (currentCategory !== "All" && currentCategory !== "Favorites" &&
            t.category !== currentCategory) continue;
        if (sv) {
            var hay = ((t.name || "") + " " + (t.category || "") + " " +
                (t.type || "") + " " + (t.section || "") + " " +
                (t.dim || "")).toLowerCase();
            if (hay.indexOf(sv) === -1) continue;
        }
        filtered.push(t);
    }

    return filtered;
}

// Warm paint reads entries persisted by an earlier session. renderOptimisticCard
// and refreshCardThumbnail record thumbnailPath (the raw disk path) but never
// thumbnail (the value the renderer reads), so a reopened panel rendered a blank
// placeholder for a card whose thumbnail.png is sitting on disk. Derive the
// renderable value here instead of persisting one: this also repairs entries
// already written by earlier sessions, and it issues a FRESH busting token — a
// persisted token is stale by construction, because it is the one the embedded
// browser already cached against.
//
// No filesystem call: the token falls back to a clock read when no mtime is
// supplied, and warm paint must complete before any disk work.
//
// thumbnailPath is never written here, so the raw-path existsSync/statSync
// probe in renderOptimisticCard keeps finding the shape it needs.
//
// Returns true when the entry was hydrated. Leaves alone:
//   - an entry with no thumbnailPath            -> placeholder stands
//   - an entry with a thumbnail and a thumbStatus
//     other than "ready"                        -> in-session value stands
function hydrateWarmPaintThumbnail(entry) {
    if (!entry || typeof entry !== "object") return false;
    var raw = entry.thumbnailPath;
    if (typeof raw !== "string" || raw === "") return false;
    var hasThumb = typeof entry.thumbnail === "string" && entry.thumbnail !== "";
    if (hasThumb && entry.thumbStatus !== "ready") return false;
    var norm = ("" + (entry.folderPath || "")).replace(/\\/g, "/");
    var url = buildBustedThumbUrl(raw, nextThumbCacheToken(norm));
    if (url === "") return false;
    entry.thumbnail = url;
    return true;
}

// Startup front half. Never shows a toast, never calls a bridge, never calls
// getCombinedDiskValidityKey. Any throw degrades to the cold path.
function startupWarmPaint(li) {
    var phase = startupTracePhase("startup.warm-paint");
    try {
        var paths = resolveStartupPaths();
        if (paths.length === 0) {
            startupPhaseEnd(phase, { painted: false, reason: "no-library-paths" });
            startupTraceCall("noteCache", "miss", "no-library-paths");
            return { painted: false, reason: "no-library-paths", cards: 0, records: 0 };
        }

        var entries = (li && li._entries) ? li._entries : null;
        if (!entries || typeof entries.length !== "number" || entries.length === 0) {
            var missReason = startupIndexReason();
            startupPhaseEnd(phase, { painted: false, reason: missReason });
            startupTraceCall("noteCache", "miss", missReason);
            return { painted: false, reason: missReason, cards: 0, records: 0 };
        }

        // Entry-identity rule: the index's own entry objects become the model,
        // with no clone, so reconciliation patching those objects field by field
        // is visible to every pending append batch.
        allTemplates = entries;
        for (var i = 0; i < allTemplates.length; i++) {
            allTemplates[i].section = getTemplateSection(allTemplates[i]);
            // Bridge thumbnailPath -> thumbnail before the first paint, or a
            // card whose thumbnail is on disk paints as a blank placeholder.
            hydrateWarmPaintThumbnail(allTemplates[i]);
        }

        var matching = filterStartupRecords();
        var painted = renderCardsFirstBatch(matching);
        startupTraceCall("noteWarmPaint", painted);
        updateCount();

        _warmPaintServedPaths = paths.join("|");
        startupTraceCall("noteCache", "hit", "index-parsed");
        startupPhaseEnd(phase, { painted: true, cards: painted, records: matching.length });

        queueStartupDeferredWork(matching, painted);
        return { painted: true, reason: "index-parsed", cards: painted, records: matching.length };
    } catch (eW) {
        startupPhaseEnd(phase, { painted: false, reason: "warm-paint-error" });
        startupTraceCall("markUnavailable", "warm-paint", String(eW));
        startupTraceCall("noteCache", "miss", "warm-paint-error");
        return { painted: false, reason: "warm-paint-error", cards: 0, records: 0 };
    }
}

// Read once by the connectDefaultLibrary callback: strict true only when warm
// paint served exactly the path set that resolves now. Consumes the flag.
function templatesWarmPaintServed() {
    var served = _warmPaintServedPaths;
    _warmPaintServedPaths = null;
    if (typeof served !== "string" || served === "") return false;
    var paths = resolveStartupPaths();
    if (paths.length === 0) return false;
    return paths.join("|") === served;
}

// requestIdleCallback when the runtime has it, setTimeout otherwise. The handle
// is registered with AppLifecycle so beforeunload releases it.
function scheduleStartupIdle(fn) {
    if (typeof fn !== "function") return null;

    var handle = null;
    var cancel = null;
    if (typeof requestIdleCallback === "function") {
        handle = requestIdleCallback(fn, { timeout: 200 });
        cancel = function (h) {
            if (typeof cancelIdleCallback === "function") cancelIdleCallback(h);
        };
    } else {
        handle = setTimeout(fn, 16);
        cancel = function (h) {
            clearTimeout(h);
        };
    }

    if (typeof AppLifecycle !== "undefined" && AppLifecycle &&
        typeof AppLifecycle.register === "function") {
        return AppLifecycle.register("timer", handle, cancel);
    }
    return {
        id: 0, dispose: function () {
            try {
                cancel(handle);
            } catch (eD) { }
        }
    };
}

function disposeStartupToken(token) {
    if (!token || typeof token.dispose !== "function") return;
    try {
        token.dispose();
    } catch (eX) { }
}

// One ordered queue: unit 1 builds the category surfaces and kicks off
// validation, units 2..n append TEMPLATE_APPEND_BATCH cards each.
function queueStartupDeferredWork(list, painted) {
    var records = (list && typeof list.length === "number") ? list : [];
    var cursor = (typeof painted === "number" && painted > 0) ? painted : 0;
    if (cursor > records.length) cursor = records.length;

    var pending = {
        session: startupSessionToken(),
        list: records,
        cursor: cursor,
        idleToken: null,
        appendsDone: false,
        reconcileDone: false,
        dirty: false,
        added: 0,
        removed: 0
    };
    _startupPending = pending;

    pending.idleToken = scheduleStartupIdle(function () {
        startupCategoryUnit(pending);
    });
    return pending;
}

// Every unit disposes its own token as its first statement, so at most one
// startup-owned handle is ever live and AppLifecycle.dispose cancels it.
function startupUnitBegin(pending) {
    disposeStartupToken(pending.idleToken);
    pending.idleToken = null;
    if (_startupPending !== pending) return false;
    return startupSessionValid(pending.session);
}

function startupCategoryUnit(pending) {
    if (!startupUnitBegin(pending)) return;

    var phase = startupTracePhase("startup.category-build");
    try {
        buildCategoryTabs();
        buildCategoryPanel();
    } catch (eB) {
        startupTraceCall("markUnavailable", "startup.category-build", String(eB));
    }
    startupPhaseEnd(phase);

    // Forward reference: scheduleStartupValidation lands with the background
    // validation/reconciliation work. Until then there is nothing to reconcile.
    try {
        if (typeof scheduleStartupValidation === "function") {
            scheduleStartupValidation(pending.session);
        } else {
            pending.reconcileDone = true;
        }
    } catch (eV) {
        pending.reconcileDone = true;
        startupTraceCall("markUnavailable", "startup.validity-key", String(eV));
    }

    // The windowed renderer owns the grid from here: mounting the whole list
    // in 60-card idle batches would defeat the bounded-mount guarantee at
    // 5,000 records. finalize (renderCards) paints the windowed view.
    try {
        if (typeof VirtualGrid !== "undefined") {
            pending.cursor = pending.list.length;
        }
    } catch (eVg) { }

    startupScheduleNextUnit(pending);
}

function startupAppendUnit(pending) {
    if (!startupUnitBegin(pending)) return;

    var from = pending.cursor;
    var remaining = pending.list.length - from;
    var step = remaining < TEMPLATE_APPEND_BATCH ? remaining : TEMPLATE_APPEND_BATCH;
    if (step < 0) step = 0;

    var phase = startupTracePhase("startup.batch-append");
    var appended = 0;
    try {
        appended = appendCardBatch(pending.list, from, step);
    } catch (eA) {
        appended = 0;
        startupTraceCall("markUnavailable", "startup.batch-append", String(eA));
    }
    startupPhaseEnd(phase, { cards: appended });
    if (appended > 0) startupTraceCall("noteBatch", appended);

    // The cursor advances by the intended step even when the batch failed, so a
    // failing unit still schedules the next one and the queue always drains.
    pending.cursor = from + step;
    startupScheduleNextUnit(pending);
}

function startupScheduleNextUnit(pending) {
    if (_startupPending !== pending) return;
    if (!startupSessionValid(pending.session)) return;

    if (pending.cursor >= pending.list.length) {
        pending.appendsDone = true;
        if (typeof maybeFinalizeStartup === "function") maybeFinalizeStartup(pending);
        return;
    }

    pending.idleToken = scheduleStartupIdle(function () {
        startupAppendUnit(pending);
    });
}

// ── Background validation, per-root diff, in-place patching ─────────
// Nothing here ever writes grid.innerHTML: cards are patched or removed one
// node at a time, so the grid is never blanked (Req 1.5, 1.6, 2.6).

// The deferred queue passes a session token; tests and direct callers may pass
// the pending record itself. Both resolve to { pending, token }.
function startupResolveSession(session) {
    if (session && typeof session === "object") {
        return { pending: session, token: session.session };
    }
    var pending = _startupPending;
    if (pending && pending.session === session && startupSessionValid(pending.session)) {
        return { pending: pending, token: session };
    }
    return { pending: null, token: session };
}

function startupLibraryIndex() {
    if (typeof getLibraryIndex !== "function") return null;
    var li = null;
    try {
        li = getLibraryIndex();
    } catch (eI) {
        return null;
    }
    return li ? li : null;
}

function startupNormalizePath(p) {
    return ("" + (p || "")).replace(/\\/g, "/").replace(/\/+$/, "");
}

// Nothing left to reconcile: release the finalize gate.
function startupMarkReconcileDone(pending) {
    if (!pending) return;
    pending.reconcileDone = true;
    maybeFinalizeStartup(pending);
}

// Async validity only: never getCombinedDiskValidityKey, never a bridge call.
// Both then handlers are supplied, so a rejection degrades to "unknown".
function scheduleStartupValidation(session) {
    var ctx = startupResolveSession(session);
    var pending = ctx.pending;
    var token = ctx.token;
    var phase = startupTracePhase("startup.validity-key");

    if (typeof deriveCombinedValidityKeyAsync !== "function") {
        startupPhaseEnd(phase, { decision: "unknown" });
        startupTraceCall("noteValidity", "unknown", [], "derive-unavailable");
        startupMarkReconcileDone(pending);
        return;
    }

    var paths = resolveStartupPaths();
    if (paths.length === 0) {
        startupPhaseEnd(phase, { decision: "unknown" });
        startupTraceCall("noteValidity", "unknown", [], "key-unavailable");
        startupMarkReconcileDone(pending);
        return;
    }

    var li = startupLibraryIndex();
    var storedKey = (li && typeof li.validityKey === "string") ? li.validityKey : null;

    // Wave 2: the stored key is handed to the async builder as its third
    // argument, so this path emits the same versioned key the synchronous
    // getCombinedDiskValidityKey emits (the two must be comparable) and skips
    // signature derivation for roots already known dirty by Root_Generation
    // (Requirement 8.4). An absent stored key still opts into the versioned
    // format: "" parses as non-v2, so every signature is derived and every root
    // in the new key is reported changed (Requirement 8.9).
    var storedKeyArg = (typeof storedKey === "string") ? storedKey : "";

    var promise = null;
    try {
        promise = deriveCombinedValidityKeyAsync(paths, undefined, storedKeyArg);
    } catch (eD) {
        promise = null;
    }
    if (!promise || typeof promise.then !== "function") {
        startupPhaseEnd(phase, { decision: "unknown" });
        startupTraceCall("noteValidity", "unknown", [], "derive-unavailable");
        startupMarkReconcileDone(pending);
        return;
    }

    promise.then(function (key) {
        if (!startupSessionValid(token)) return;

        if (typeof key !== "string" || key === "") {
            startupPhaseEnd(phase, { decision: "unknown" });
            startupTraceCall("noteValidity", "unknown", [], "key-unavailable");
            startupMarkReconcileDone(pending);
            return;
        }

        if (key === storedKey) {
            startupPhaseEnd(phase, { decision: "fresh" });
            startupTraceCall("noteValidity", "fresh", []);
            startupMarkReconcileDone(pending);
            return;
        }

        var changed = changedRootsFromKeys(storedKey, key);
        startupPhaseEnd(phase, { decision: "stale", changedRoots: changed.length });
        startupTraceCall("noteValidity", "stale", changed);
        rescanChangedRoots(pending, changed, key);
    }, function (eK) {
        if (!startupSessionValid(token)) return;
        startupPhaseEnd(phase, { decision: "unknown" });
        startupTraceCall("noteValidity", "unknown", [], "key-unavailable");
        startupTraceCall("markUnavailable", "startup.validity-key", String(eK));
        startupMarkReconcileDone(pending);
    });
}

// ── Changed-root diff over the versioned Combined_Validity_Key ──────
// Wave 2: both keys go through the shipped parseCombinedValidityKey, so a path
// is recovered by its explicit field separator instead of by guessing where the
// colons stop being part of a Windows path. No I/O of any kind happens here.
//
// The parse is behind a typeof probe and a try/catch, and the returned shape is
// validated field by field before anything branches on it, so an absent or
// inert persistence layer degrades to "not versioned" rather than throwing.
function startupParseValidityKey(key) {
    if (typeof parseCombinedValidityKey !== "function") return null;
    var parsed = null;
    try {
        parsed = parseCombinedValidityKey(key);
    } catch (eP) {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== 2) return { version: 1, tokens: null };
    if (!parsed.tokens || typeof parsed.tokens !== "object") return { version: 1, tokens: null };
    return { version: 2, tokens: parsed.tokens };
}

// Recover the root path from a legacy segment prefix by dropping the trailing
// numeric key fields ("<count>:<size>"). Pure string work.
function startupRootFromKeyPrefix(prefix) {
    var out = "" + (prefix || "");
    for (var n = 0; n < 2; n++) {
        var at = out.lastIndexOf(":");
        if (at <= 0) break;
        var tail = out.substring(at + 1);
        if (tail === "" || !/^[0-9]+$/.test(tail)) break;
        out = out.substring(0, at);
    }
    return out;
}

// The roots a key names, in either format. A v2 key hands them over exactly; a
// pre-Wave-2 key is split on ";" and each segment's trailing numeric fields are
// dropped, which is all the ambiguous legacy format allows.
function startupRootsFromKey(key) {
    var roots = [];
    if (typeof key !== "string" || key === "") return roots;

    var parsed = startupParseValidityKey(key);
    // No parser in this context: the format cannot be decided, so no root is
    // named. There is nothing to reconcile against without the persistence
    // layer that produced the key.
    if (!parsed) return roots;
    if (parsed.version === 2) {
        for (var path in parsed.tokens) {
            if (!Object.prototype.hasOwnProperty.call(parsed.tokens, path)) continue;
            if (path && roots.indexOf(path) === -1) roots.push(path);
        }
        return roots;
    }

    var segments = key.split(";");
    for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];
        if (!seg) continue;
        var at = seg.lastIndexOf(":");
        if (at <= 0) continue;
        var root = startupRootFromKeyPrefix(seg.substring(0, at));
        if (root && roots.indexOf(root) === -1) roots.push(root);
    }
    return roots;
}

// Roots present in the new key whose token differs from, or is missing in, the
// stored key. When the stored key is not v2 — legacy, null, or "" — every root
// in the new key is reported changed (Requirement 8.9); nothing persisted is
// discarded, because warm paint already served those entries and the background
// reconcile patches them in place.
function changedRootsFromKeys(storedKey, newKey) {
    var changed = [];
    if (typeof newKey !== "string" || newKey === "") return changed;

    var stored = startupParseValidityKey(storedKey);
    var next = startupParseValidityKey(newKey);
    var comparable = !!(stored && stored.version === 2 && next && next.version === 2);

    var roots = startupRootsFromKey(newKey);
    for (var i = 0; i < roots.length; i++) {
        var root = roots[i];
        if (comparable && Object.prototype.hasOwnProperty.call(stored.tokens, root)) {
            if (stored.tokens[root] === next.tokens[root]) continue;
        }
        if (changed.indexOf(root) === -1) changed.push(root);
    }
    return changed;
}

// The configured path string for a normalized root, so the bridge call uses the
// same spelling the cold path uses.
function startupResolveScanRoot(root) {
    var norm = startupNormalizePath(root);
    var paths = resolveStartupPaths();
    for (var i = 0; i < paths.length; i++) {
        if (startupNormalizePath(paths[i]) === norm) return paths[i];
    }
    return root;
}

function startupRecordInRoot(record, root, singleRoot) {
    if (!record) return false;
    var sp = record.sourcePath;
    if (typeof sp !== "string" || sp === "") return singleRoot === true;
    return startupNormalizePath(sp) === startupNormalizePath(root);
}

// Identity within one root: id first, then name+category.
function findStartupEntryByIdentity(record, root, singleRoot) {
    if (!record) return null;
    var i, e;
    if (record.id !== undefined && record.id !== null && record.id !== "") {
        for (i = 0; i < allTemplates.length; i++) {
            e = allTemplates[i];
            if (!startupRecordInRoot(e, root, singleRoot)) continue;
            if (e.id !== undefined && e.id !== null && e.id === record.id) return e;
        }
    }
    for (i = 0; i < allTemplates.length; i++) {
        e = allTemplates[i];
        if (!startupRecordInRoot(e, root, singleRoot)) continue;
        if (e.name === record.name && e.category === record.category) return e;
    }
    return null;
}

// Entry-identity rule: fields are copied ONTO the existing entry object, never
// replacing it, so pending append batches keep rendering current data.
function copyStartupRecordFields(source, target) {
    for (var k in source) {
        if (!Object.prototype.hasOwnProperty.call(source, k)) continue;
        target[k] = source[k];
    }
    if (typeof getTemplateSection === "function") {
        target.section = getTemplateSection(target);
    }
}

function startupIdentityKeys(record) {
    var keys = [];
    if (!record) return keys;
    if (record.id !== undefined && record.id !== null && record.id !== "") {
        keys.push("id:" + record.id);
    }
    keys.push("nc:" + (record.name || "") + "||" + (record.category || ""));
    return keys;
}

// ── Bug C: media entries are index-only state ───────────────────────
// Media records (js/core/fastMediaEngine.js) live in the shared library
// index; a bridge scan can reconstruct some of them (meta.json is written
// on the production import path) but not all, and their ids ("media-...")
// never match the hex-encoded folder names the scan returns
// (mediaIdFolderSegment). Every wholesale `li._entries = <scan results>.slice()`
// would therefore evict the media entries the scan cannot reconstruct. These
// helpers preserve surviving media entries across each replace and across the
// reconcile removal pass — but ONLY entries with no valid counterpart in the
// scan: when the scan DID return a matching record, the preserved entry is
// dropped so it can never shadow or duplicate the fresh scan record.
function isMediaIndexEntry(entry) {
    if (!entry || typeof entry !== "object") return false;
    if (entry.type === "media") return true;
    var id = typeof entry.id === "string" ? entry.id : "";
    return id.indexOf("media-") === 0 || id.indexOf("legacy-") === 0;
}

// Whether a scan record is the on-disk counterpart of a media index entry.
// The entry id and the scanned folder name differ (hex-encoded segment), so
// identity falls back to path — media entries carry sourcePath/mediapath
// (not folderPath), compared against the scan record's folderPath — then
// name+category. Any match means the scan record supersedes the preserved
// entry in the merge below.
function mediaScanRecordMatchesEntry(record, entry) {
    if (!record || !entry) return false;
    if (record.id !== undefined && record.id !== null && record.id !== "" && record.id === entry.id) return true;
    // Only a meta-backed media record (type === "media") can reconstruct the
    // entry. A media folder WITHOUT meta.json scans as a degraded record —
    // id/name are the hex folder segment and type is the SECTION name — and
    // must never stand in for the real entry, or its id/mediaFile/sourcePath
    // are dropped and the downgrade is persisted in their place.
    if (record.type !== "media") return false;
    var recordFolder = startupNormalizePath(record.folderPath || "");
    if (recordFolder !== "") {
        var paths = [entry.sourcePath, entry.mediapath, entry.folderPath];
        for (var p = 0; p < paths.length; p++) {
            var entryPath = startupNormalizePath(paths[p] || "");
            if (entryPath !== "" && entryPath === recordFolder) return true;
        }
    }
    return record.name === entry.name && record.category === entry.category;
}

// Merge-before-replace: returns `scanResults` plus every media entry from
// `previous` that has NO valid counterpart in the scan (per
// mediaScanRecordMatchesEntry). Preserved entries with a matching scan record
// are DROPPED — the scan record wins, so a preserved entry can never shadow
// or duplicate it. Scan ordering is preserved verbatim; surviving media
// entries are APPENDED AT THE TAIL in their prior relative order (the scan
// can say nothing about where they belong, and the grid renders media cards
// through keyed insertion anyway).
function mergeSurvivingMediaEntries(scanResults, previous) {
    var merged = [];
    var i, j;
    var scan = (scanResults && typeof scanResults.length === "number") ? scanResults : [];
    for (i = 0; i < scan.length; i++) merged.push(scan[i]);
    var old = (previous && typeof previous.length === "number") ? previous : [];
    for (i = 0; i < old.length; i++) {
        var entry = old[i];
        if (!isMediaIndexEntry(entry)) continue;
        var matched = false;
        for (j = 0; j < scan.length; j++) {
            if (mediaScanRecordMatchesEntry(scan[j], entry)) { matched = true; break; }
        }
        // A valid scan counterpart exists: keep the scan record (already in
        // `merged`) and drop this stale preserved entry.
        if (!matched) merged.push(entry);
    }
    return merged;
}

function startupCssAttrValue(value) {
    return ("" + (value === undefined || value === null ? "" : value))
        .replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// tpl-<id> first, then the data-file/data-cat fallback inside the active grid.
function resolveTemplateCardNode(record) {
    if (!record) return null;
    if (record.id !== undefined && record.id !== null && record.id !== "" &&
        typeof document !== "undefined" && document && typeof document.getElementById === "function") {
        var byId = document.getElementById("tpl-" + record.id);
        if (byId) return byId;
    }
    if (typeof document === "undefined" || !document || typeof document.getElementById !== "function") return null;
    var grid = document.getElementById(resolveSectionGridId());
    if (!grid || typeof grid.querySelector !== "function") return null;
    return grid.querySelector('.card[data-file="' + startupCssAttrValue(record.name) +
        '"][data-cat="' + startupCssAttrValue(record.category) + '"]');
}

// One node replaced in place. Never touches grid.innerHTML. No-ops when the
// card is not rendered yet — the model is already current, so a later append
// batch or the finalize re-render shows the fresh record.
function patchTemplateCard(record) {
    var node = resolveTemplateCardNode(record);
    if (!node) return false;
    node.outerHTML = renderTemplateCardMarkup(record, currentSection, tmpBulkSelected);
    return true;
}

function removeTemplateCardNode(record) {
    var node = resolveTemplateCardNode(record);
    if (!node) return false;
    if (node.parentNode && typeof node.parentNode.removeChild === "function") {
        node.parentNode.removeChild(node);
        return true;
    }
    if (typeof node.remove === "function") {
        node.remove();
        return true;
    }
    return false;
}

// One getAllTemplates bridge scan per CHANGED root only. Unchanged roots are
// never scanned and their cards are never touched (Req 1.9, 7.4).
function rescanChangedRoots(session, changed, newKey) {
    var ctx = startupResolveSession(session);
    var pending = ctx.pending;
    var token = ctx.token;

    var roots = [];
    var list = (changed && typeof changed.length === "number") ? changed : [];
    for (var i = 0; i < list.length; i++) {
        if (typeof list[i] === "string" && list[i] !== "") roots.push(list[i]);
    }
    if (roots.length === 0) {
        startupMarkReconcileDone(pending);
        return;
    }

    var bridgeReady = typeof csInterface !== "undefined" && csInterface &&
        typeof csInterface.evalScript === "function" && typeof encodeBridge === "function";
    if (!bridgeReady) {
        startupTraceCall("markUnavailable", "startup.bridge-scan", "bridge-unavailable");
        startupMarkReconcileDone(pending);
        return;
    }

    var scannedByRoot = {};
    var flat = [];
    var completed = 0;
    var total = roots.length;

    for (var r = 0; r < roots.length; r++) {
        (function (rootKey) {
            var scanRoot = startupResolveScanRoot(rootKey);
            var phase = startupTracePhase("startup.bridge-scan");
            // Section-chunked, exactly like the cold path: reconciliation used to
            // hold After Effects' main thread for the entire library in one call.
            startupScanRootBySection(scanRoot, token, null, function (records, failed) {
                if (!startupSessionValid(token)) return;
                startupPhaseEnd(phase, { root: scanRoot, records: records.length });

                if (failed === true) {
                    // An incomplete scan must not drive reconciliation: the
                    // removal pass treats every record missing from the scan as
                    // deleted, so a failed section would delete real cards and
                    // then persist the loss. Leave the index alone and let a
                    // later explicit refresh rescan.
                    startupTraceCall("markUnavailable", "startup.bridge-scan", "incomplete-scan");
                    var li = startupLibraryIndex();
                    if (li) li._needsFullScan = true;
                    startupMarkReconcileDone(pending);
                    return;
                }

                scannedByRoot["r:" + startupNormalizePath(rootKey)] = records;
                flat = flat.concat(records);

                completed++;
                if (completed === total) {
                    startupReconcileScanned(pending, token, roots, scannedByRoot, flat, newKey);
                }
            });
        })(roots[r]);
    }
}

// LibraryIndex.reconcile exactly as it exists today: chunked at 50 ms per work
// unit, with the processor patching matched entries in place.
function startupReconcileScanned(pending, token, roots, scannedByRoot, flat, newKey) {
    if (!startupSessionValid(token)) return;

    var singleRoot = resolveStartupPaths().length <= 1;
    var phase = startupTracePhase("startup.reconcile");
    var counters = { added: 0, removed: 0 };

    var processor = function (record) {
        if (!startupSessionValid(token)) return;
        if (!record) return;
        var root = typeof record.sourcePath === "string" ? record.sourcePath : "";
        var existing = null;
        if (isMediaIndexEntry(record) && record.id !== undefined && record.id !== null && record.id !== "") {
            // Media entries carry the ORIGINAL imported file path in
            // sourcePath — never a library root — so the root-filtered
            // identity lookup can never match them. Match by id across all
            // roots, or every generation-bumped startup appends a fresh
            // duplicate of every media record the scan reconstructed.
            for (var t = 0; t < allTemplates.length; t++) {
                if (allTemplates[t] && allTemplates[t].id === record.id) { existing = allTemplates[t]; break; }
            }
        } else {
            existing = findStartupEntryByIdentity(record, root, singleRoot);
        }
        if (existing) {
            copyStartupRecordFields(record, existing);
            markTemplatesDirty();          // S1 — derived-field write in place, no catalog mirror, no shape change
            patchTemplateCard(existing);
            return;
        }
        if (typeof getTemplateSection === "function") record.section = getTemplateSection(record);
        allTemplates.push(record);
        markTemplatesDirty();              // S2 — additive and free; the length probe already fires
        counters.added++;
    };

    var li = startupLibraryIndex();
    if (li && typeof li.reconcile === "function") {
        li.reconcile(flat, processor, { workUnitMs: 50 }).then(function () {
            if (!startupSessionValid(token)) return;
            startupPhaseEnd(phase, { records: flat.length });
            startupReconcileFinish(pending, token, roots, scannedByRoot, singleRoot, counters, newKey, true);
        }, function (eR) {
            if (!startupSessionValid(token)) return;
            startupPhaseEnd(phase, { records: flat.length, failed: true });
            startupTraceCall("markUnavailable", "startup.reconcile", String(eR));
            // reconcile has raised _needsFullScan for a later refresh; nothing
            // is persisted from a partial pass.
            startupReconcileFinish(pending, token, roots, scannedByRoot, singleRoot, counters, newKey, false);
        });
        return;
    }

    try {
        for (var i = 0; i < flat.length; i++) processor(flat[i]);
    } catch (eL) {
        startupTraceCall("markUnavailable", "startup.reconcile", String(eL));
    }
    startupPhaseEnd(phase, { records: flat.length });
    startupReconcileFinish(pending, token, roots, scannedByRoot, singleRoot, counters, newKey, false);
}

// Removals, then persistence, then the finalize gate.
function startupReconcileFinish(pending, token, roots, scannedByRoot, singleRoot, counters, newKey, persist) {
    if (!startupSessionValid(token)) return;

    for (var r = 0; r < roots.length; r++) {
        var rootKey = roots[r];
        var scanned = scannedByRoot["r:" + startupNormalizePath(rootKey)];
        if (!scanned || typeof scanned.length !== "number") continue;

        var present = {};
        for (var s = 0; s < scanned.length; s++) {
            var sk = startupIdentityKeys(scanned[s]);
            for (var k = 0; k < sk.length; k++) present[sk[k]] = true;
        }

        for (var i = allTemplates.length - 1; i >= 0; i--) {
            var entry = allTemplates[i];
            if (!startupRecordInRoot(entry, rootKey, singleRoot)) continue;
            // Bug C: media entries are identity-preserved here. Their ids
            // never match the scan's hex-encoded folder names, so absence
            // from the scan is NOT deletion evidence; media removal flows
            // through the dedicated media delete path instead.
            if (isMediaIndexEntry(entry)) continue;
            var keys = startupIdentityKeys(entry);
            var found = false;
            for (var m = 0; m < keys.length; m++) {
                if (present[keys[m]]) { found = true; break; }
            }
            if (found) continue;
            allTemplates.splice(i, 1);
            markTemplatesDirty();          // S3 — free (length probe fires); also closes add-1-remove-1, where length returns to its original value
            removeTemplateCardNode(entry);
            counters.removed++;
        }
    }

    if (pending) {
        pending.added += counters.added;
        pending.removed += counters.removed;
        if (counters.added > 0 || counters.removed > 0) pending.dirty = true;
    }

    if (persist === true) {
        var li = startupLibraryIndex();
        if (li) {
            try {
                // A persisted "gen" placeholder (root known dirty by
                // generation, signature never derived) can never satisfy the
                // warm-path equality check — it would force one more full
                // rescan next startup. The rescan just walked these roots,
                // so materialize the real disk signatures now (the sync
                // builder emits the exact key the warm path compares).
                if (typeof newKey === "string" && newKey.indexOf("~gen") !== -1 &&
                    typeof getCombinedDiskValidityKey === "function") {
                    var realKey = getCombinedDiskValidityKey(resolveStartupPaths());
                    if (typeof realKey === "string" && realKey !== "" && realKey.indexOf("~gen") === -1) {
                        newKey = realKey;
                    }
                }
                li.validityKey = newKey;
                // Bug C: merge-before-replace — defensive twin of the warm
                // and cold paths, so no surviving media entry is lost even
                // when li._entries is not the same array as allTemplates.
                li._entries = mergeSurvivingMediaEntries(allTemplates, li._entries);
                if (typeof saveLibraryIndex === "function") saveLibraryIndex();
            } catch (eS) {
                startupTraceCall("markUnavailable", "startup.reconcile", String(eS));
            }
        }
    }

    startupMarkReconcileDone(pending);
}

// Runs once, only when appends and reconciliation are both done. Field-only
// changes need nothing: those cards were already patched in place.
function maybeFinalizeStartup(session) {
    var ctx = startupResolveSession(session);
    var pending = ctx.pending;
    if (!pending) return false;
    if (pending.appendsDone !== true || pending.reconcileDone !== true) return false;
    if (pending.finalized === true) return false;
    pending.finalized = true;
    if (!startupSessionValid(pending.session)) return false;
    if (pending.dirty !== true) return false;

    try {
        buildCategoryTabs();
        buildCategoryPanel();
        filterAndRender();
        updateCount();
        startupTraceMarkFinalRerender();
    } catch (eN) {
        startupTraceCall("markUnavailable", "startup.reconcile", String(eN));
        return false;
    }
    return true;
}

function renderCards(templates) {
    if (_CardView && typeof _CardView.renderCards === "function") {
        _CardView.renderCards(templates);
        return;
    }
    var grid = document.getElementById(resolveSectionGridId());
    if (!grid) return;

    if (templates.length === 0) {
        var sb = DOM["search-box"];
        var isS = sb && sb.value.trim();
        var hint = "Press Ctrl+S to save one";
        if (currentSection === SECTIONS.COMP) hint = "Open or select a comp & save";
        else if (currentSection === SECTIONS.TEXT_PROPS) hint = "Select one text layer & save properties";
        else if (currentSection === SECTIONS.TEXT) hint = "Select text layer(s) & save";
        else if (currentSection === SECTIONS.FOOTAGE) hint = "Select footage layer(s) & save";
        else if (currentSection === SECTIONS.EFFECT) hint = "Select layer or effect(s) & save";
        else if (isImageSection(currentSection)) hint = "Select image in AE & save";

        // Shared empty-state pattern (base.css §2.2): container → icon → title → text.
        // Per-category empty state (Req 14.8); same trigger/content as before.
        if (hasVGrid()) VirtualGrid.forget(resolveSectionGridId());
        grid.innerHTML =
            '<div class="tpl-empty-state cs-empty-state">' +
            '<span class="cs-empty-state__icon" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg>' +
            "</span>" +
            '<p class="cs-empty-state__title">' +
            (isS ? "No results found" : "No templates yet") + "</p>" +
            '<p class="cs-empty-state__text">' +
            (isS ? "Try a different search" : hint) + "</p></div>";
        return;
    }

    // Windowed mount: only the viewport window (plus overscan) becomes DOM.
    // The markup, ids, data attributes and grid delegation are unchanged.
    // Without the virtual-grid module this degrades to the original full
    // innerHTML render (public contract preserved for standalone loaders).
    var gridId = resolveSectionGridId();
    if (!hasVGrid()) {
        var htmlOld = [];
        for (var o = 0; o < templates.length; o++) {
            htmlOld.push(renderTemplateCardMarkup(templates[o], currentSection, tmpBulkSelected));
        }
        grid.innerHTML = htmlOld.join("");
        attachSectionHoverPreviews(grid);
        return;
    }
    var ids = [];
    for (var i = 0; i < templates.length; i++) {
        if (templates[i].id !== undefined && templates[i].id !== null) ids.push(templates[i].id);
    }
    VirtualGrid.render(gridId, grid, gridId + "|direct", ids, {
        section: currentSection,
        selectedKeys: tmpBulkSelected,
        onPainted: function (mountedGrid) {
            attachSectionHoverPreviews(mountedGrid);
        }
    });
}

function attachGlobalCardDelegation() {
    if (_Actions && typeof _Actions.attachGlobalCardDelegation === "function") {
        _Actions.attachGlobalCardDelegation();
        return;
    }
    // One-time windowed-grid wiring: markup source + rAF scheduling.
    if (typeof VirtualGrid !== "undefined") {
        VirtualGrid.init({
            markupFor: renderTemplateCardMarkup,
            requestAnimationFrame: (typeof window !== "undefined" && window.requestAnimationFrame) ? window.requestAnimationFrame : null
        });
    }
    var cardGrids = ["comp-list-container", "transition-list-container",
        "text-list-container", "footage-list-container", "effect-list-container", "icon-list-container"];
    for (var i = 0; i < cardGrids.length; i++) {
        var grid = document.getElementById(cardGrids[i]);
        if (!grid) continue;

        grid.addEventListener("click", function (e) {
            var card = e.target.closest(".card");
            if (!card) return;

            // Intercept clicks when templates bulk delete mode is active (All template sub-sections)
            if (tmpBulkMode) {
                e.preventDefault();
                e.stopPropagation();
                var key = card.dataset.file + "||" + card.dataset.cat;
                var idx = tmpBulkSelected.indexOf(key);
                if (idx > -1) {
                    tmpBulkSelected.splice(idx, 1);
                    card.classList.remove("selected-for-delete");
                } else {
                    tmpBulkSelected.push(key);
                    card.classList.add("selected-for-delete");
                }
                updateTmpBulkCount();
                return;
            }

            if (e.target.closest(".btn-delete")) {
                e.stopPropagation();
                deleteTemplate(card.dataset.file, card.dataset.cat, card.dataset.folder);
            } else if (e.target.closest(".btn-rename")) {
                e.stopPropagation();
                openRenameModal(card);
            } else if (e.target.closest(".btn-move")) {
                e.stopPropagation();
                openMoveModal(card);
            } else if (e.target.closest(".btn-import")) {
                e.stopPropagation();
                importCurrentCardToTimeline(card);
            } else if (e.target.closest(".btn-favorite")) {
                e.stopPropagation();
                toggleFavorite(card);
            } else if (e.target.closest(".btn-more")) {
                e.stopPropagation();
                var rect = e.target.closest(".btn-more").getBoundingClientRect();
                openIconRightClickPopup(card, rect.left, rect.bottom);
            } else if (e.target.closest('[data-ta-act="genpreview"]')) {
                e.stopPropagation();
                var btn = e.target.closest('[data-ta-act="genpreview"]');
                btn.classList.add("rendering");
                btn.textContent = "Rendering...";
                btn.disabled = true;
                var aepPath = card.dataset.folder + "/project.aep";
                TextAnim.enqueuePreviewRender(aepPath, card.dataset.file, function (err) {
                    btn.classList.remove("rendering");
                    btn.textContent = "Preview";
                    btn.disabled = false;
                    if (err) {
                        showToast("Preview generation failed", "error");
                    } else {
                        showToast("Preview ready", "success");
                    }
                });
            } else {
                // Default action: Single click on the card imports the template
                // Prevent import if clicking on any future interactive elements not explicitly handled above
                if (e.target.closest("button") || e.target.closest("a") || e.target.closest("input") ||
                    e.target.closest(".card-btn-del") || e.target.closest(".card-btn-rename") ||
                    e.target.closest(".card-btn-more") || e.target.closest(".btn-icon")) {
                    return;
                }

                e.preventDefault();
                importCurrentCardToTimeline(card);
            }
        });

        grid.addEventListener("dblclick", function (e) {
            var card = e.target.closest(".card");
            if (!card) return;
            // Prevent text selection when double clicking quickly, but do not trigger import
            e.preventDefault();
        });
    }
}

function attachGlobalIconDelegation() {
    // Handled by attachGlobalCardDelegation
}

// ── Helper: resolve the library ROOT a template belongs to ─────────
// For a media record `sourcePath` is the ORIGINAL IMPORTED FILE PATH, never a
// library root (see the note in the startup reconciler below and the record
// built by js/core/fastMediaEngine.js). Returning it here sent a file path to
// the host as `tRoot`, which then probed <file path>/<section>/<cat>/<id> and
// could never resolve. A media record's root is recoverable from its own
// folderPath, which the writer builds as
// <root>/<section>/<safeCategory>/<idSegment> — so stripping the last three
// segments yields the root exactly, and keeps working after the active library
// root changes.
function mediaRootFromFolderPath(folderPath) {
    var p = ("" + (folderPath || "")).replace(/\\/g, "/").replace(/\/+$/, "");
    if (!p) return "";
    var cut = p;
    var n;
    for (n = 0; n < 3; n++) {
        var at = cut.lastIndexOf("/");
        if (at <= 0) return "";
        cut = cut.substring(0, at);
    }
    return cut;
}

function getTemplateSourcePath(name, cat) {
    for (var i = 0; i < allTemplates.length; i++) {
        if (allTemplates[i].name === name && allTemplates[i].category === cat) {
            var rec = allTemplates[i];
            var isMedia = (typeof isMediaIndexEntry === "function")
                ? isMediaIndexEntry(rec)
                : (rec && rec.type === "media");
            if (isMedia) {
                var derived = mediaRootFromFolderPath(rec.folderPath);
                return derived || rootPath;
            }
            return rec.sourcePath || rootPath;
        }
    }
    return rootPath; // fallback to rootPath if not found
}

// ── Helper: the category segment of an image save folder ───────────
// The host folds the category at decode time and sanitizes the folded value;
// the panel sanitized the raw string instead, so any category carrying a TAB,
// a CR/LF, a run of two or more spaces or leading/trailing whitespace produced
// a folder the host had never created — an unfindable folder and a permanently
// blank card. cleanName is the panel twin of that decode-time fold, and the
// fold is idempotent, so this is a no-op for every already-clean category and
// re-keys nothing on disk.
// Guarded: a realm that did not load the path-builder module degrades to the
// previous behaviour instead of throwing, same style as _getTemplateFolderPath
// below.
function safeCategorySegment(cat) {
    var folded = (typeof cleanName === "function") ? cleanName(cat) : cat;
    return (typeof getSafeName === "function") ? getSafeName(folded) : folded;
}

// ── Optimistic UI Helpers ──────────────────────────────────────────

// The allTemplates record backing the card named (name, cat) in the active
// section, or null. The predicate is character-for-character the one
// removeUITemplate and patchUITemplate already scan with — name, category and
// a literal rec.section === currentSection — so the folder path resolved from
// this record and the record those two go on to mutate are always the same
// card. Keep the three in step: divergence here means the path addressed in
// the index and the record patched in memory drift apart.
function _findUITemplateRecord(name, cat) {
    for (var i = 0; i < allTemplates.length; i++) {
        var t = allTemplates[i];
        if (t && t.name === name && t.category === cat) {
            if (!currentSection || t.section === currentSection || (typeof getTemplateSection === "function" && getTemplateSection(t) === currentSection)) {
                return t;
            }
        }
    }
    for (var j = 0; j < allTemplates.length; j++) {
        if (allTemplates[j] && allTemplates[j].name === name && allTemplates[j].category === cat) {
            return allTemplates[j];
        }
    }
    return null;
}

function _getTemplateFolderPath(name, cat) {
    // If the backing record already holds its on-disk folderPath, that is the authoritative
    // key used by LibraryIndex and disk scanners. Use it directly so we never drift.
    var rec = _findUITemplateRecord(name, cat);
    if (rec && rec.folderPath) {
        return typeof normalizeFolderPath === "function"
            ? normalizeFolderPath(rec.folderPath)
            : ("" + rec.folderPath).replace(/\\/g, "/").replace(/\/+$/, "");
    }

    var isMedia = rec && ((typeof isMediaIndexEntry === "function")
        ? isMediaIndexEntry(rec)
        : rec.type === "media");
    if (isMedia) {
        var mediaFolder = typeof normalizeFolderPath === "function"
            ? normalizeFolderPath(rec.folderPath)
            : ("" + (rec.folderPath || "")).replace(/\\/g, "/").replace(/\/+$/, "");
        if (mediaFolder) return mediaFolder;
    }

    var sourcePath = getTemplateSourcePath(name, cat);
    var safeCat = typeof getSafeName === "function" ? getSafeName(cat) : cat;
    var safeName = typeof generateTemplateId === "function" ? generateTemplateId(name) : name;
    var normRoot = typeof normalizeFolderPath === "function" ? normalizeFolderPath(sourcePath) : sourcePath;
    var normSection = typeof normalizeSectionName === "function" ? normalizeSectionName(currentSection) : currentSection;
    return normRoot + "/" + normSection + "/" + safeCat + "/" + safeName;
}

function removeUITemplate(name, cat, explicitFolderPath) {
    var folderPath = explicitFolderPath || _getTemplateFolderPath(name, cat);
    var li = typeof getLibraryIndex === "function" ? getLibraryIndex() : null;
    if (li) {
        try {
            li.removeEntry(folderPath);
        } catch (eLi) {
            // If primary key lookup failed, attempt removal by name + category match
            if (li._entries && Array.isArray(li._entries)) {
                for (var le = 0; le < li._entries.length; le++) {
                    var ent = li._entries[le];
                    if (ent && ent.name === name && ent.category === cat) {
                        li._entries.splice(le, 1);
                        break;
                    }
                }
            }
        }
        saveLibraryIndex();
    }
    for (var i = 0; i < allTemplates.length; i++) {
        var t = allTemplates[i];
        var matches = (t.name === name && t.category === cat && (!currentSection || t.section === currentSection)) ||
                      (folderPath && t.folderPath && (t.folderPath.replace(/\\/g, "/") === folderPath.replace(/\\/g, "/")));
        if (matches) {
            var removed = allTemplates.splice(i, 1)[0];
            if (removed && typeof TemplateCatalog !== "undefined") TemplateCatalog.remove(removed);
            markTemplatesDirty();          // S4 — additive to the remove above, and free: the length probe already fires
            break;
        }
    }
    filterAndRender();
}

function patchUITemplate(name, cat, patchObj, newName, newCat) {
    var folderPath = _getTemplateFolderPath(name, cat);
    var li = typeof getLibraryIndex === "function" ? getLibraryIndex() : null;
    var liEntry = null;
    if (li) {
        liEntry = li.patchEntry(folderPath, patchObj);
        saveLibraryIndex();
    }
    var mutated = null;
    for (var i = 0; i < allTemplates.length; i++) {
        if (allTemplates[i].name === name && allTemplates[i].category === cat && allTemplates[i].section === currentSection) {
            var previous = allTemplates[i];
            var before = {
                category: previous.category,
                favorite: previous.favorite,
                section: getTemplateSection(previous)
            };
            for (var key in patchObj) {
                if (patchObj.hasOwnProperty(key)) allTemplates[i][key] = patchObj[key];
            }
            if (newName !== undefined) allTemplates[i].name = newName;
            if (newCat !== undefined) allTemplates[i].category = newCat;
            mutated = allTemplates[i];
            if (typeof TemplateCatalog !== "undefined") TemplateCatalog.patch(mutated, before);
            markTemplatesDirty();          // S5 — the manual patch above is incomplete for an id change (rename), so force a rebuild
            break;
        }
    }
    var structural = newName !== undefined || newCat !== undefined;
    if (structural) {
        buildCategoryTabs();
        buildCategoryPanel();
    }

    var recordChangedView =
        (currentCategory === "Favorites" && patchObj && patchObj.hasOwnProperty("favorite")) ||
        structural ||
        activeSearchQuery();

    if (recordChangedView) {
        // Membership of the visible list changed: recompute and repaint.
        filterAndRender();
    } else {
        // Local mutation: patch the mounted card in place, refresh counts.
        // No grid rebuild, no record scan. If the card is offscreen nothing
        // is patched — the catalog already holds the new state, so the
        // remount renders correctly.
        updateCategoryCountsOnly();
        if (mutated) patchTemplateCard(mutated);
    }
}

// Refresh only the counts in the mounted category panel rows.
function updateCategoryCountsOnly() {
    var list = DOM["cat-panel-list"];
    if (!list || !hasCatalog()) return;
    var cCounts = TemplateCatalog.sectionCounts(currentSection);
    var rows = list.querySelectorAll(".cat-panel-item");
    for (var r = 0; r < rows.length; r++) {
        var rowCat = rows[r].dataset.cat;
        var n = rowCat === "All" ? cCounts.all :
            rowCat === "Favorites" ? cCounts.favorites :
                (cCounts.cats[rowCat] || 0);
        var badge = rows[r].querySelector(".cat-count");
        if (badge) badge.textContent = String(n);
    }
}

function activeSearchQuery() {
    var sb = DOM["search-box"];
    return sb ? !!sb.value.trim() : false;
}
// ───────────────────────────────────────────────────────────────────

function toggleFavorite(card) {
    if (!card) return;
    var name = card.dataset.file;
    var cat = card.dataset.cat;
    var isFav = card.classList.contains("is-fav");
    csInterface.evalScript(
        'toggleFavTemplate("' +
        encodeBridge(name) + '","' +
        encodeBridge(cat) + '","' +
        encodeBridge(getTemplateSourcePath(name, cat)) + '")',
        function () {
            patchUITemplate(name, cat, { favorite: !isFav });
        }
    );
}

function deleteTemplate(name, cat, folderPath) {
    if (Settings.get("ui.confirmDelete")) {
        if (!confirm("Delete: " + name + "?")) return;
    }
    if (!folderPath) {
        var rec = _findUITemplateRecord(name, cat);
        if (rec && rec.folderPath) folderPath = rec.folderPath;
        if (!folderPath) folderPath = _getTemplateFolderPath(name, cat);
    }
    csInterface.evalScript(
        'deleteTemplate("' +
        encodeBridge(name) + '","' +
        encodeBridge(cat) + '","' +
        encodeBridge(getTemplateSourcePath(name, cat)) + '","' +
        encodeBridge(folderPath || "") + '")',
        function (resHex) {
            var res = (typeof decodeBridge === "function") ? decodeBridge(resHex) : resHex;
            if (res === "false") {
                showToast('Could not delete "' + name + '" (file may be in use)', "error");
                return;
            }
            showToast('Deleted "' + name + '"', "success");
            csBumpRootGeneration(getTemplateSourcePath(name, cat));
            removeUITemplate(name, cat, folderPath);
        }
    );
}

// ── Templates Bulk Delete Logic ────────────────────────────────────
function getActiveGridId() {
    var gridId = "comp-list-container";
    if (currentSection === SECTIONS.LAYER) gridId = "transition-list-container";
    else if (isTextSection(currentSection)) gridId = "text-list-container";
    else if (currentSection === SECTIONS.FOOTAGE) gridId = "footage-list-container";
    else if (currentSection === SECTIONS.EFFECT) gridId = "effect-list-container";
    else if (isImageSection(currentSection)) gridId = "icon-list-container";
    return gridId;
}

function setTmpBulkMode(on) {
    tmpBulkMode = on;
    tmpBulkSelected = [];
    var toggle = document.getElementById("btn-tmp-bulk-toggle");
    var countEl = document.getElementById("tmp-delete-count");
    var confirm = document.getElementById("tmp-bulk-confirm");
    if (toggle) toggle.classList.toggle("active", on);
    if (countEl) {
        countEl.textContent = "(0)";
        countEl.style.display = on ? "inline-block" : "none";
    }
    if (confirm) confirm.classList.remove("show");

    // Toggle bulk-mode class on the active grid container
    var gridId = getActiveGridId();
    var grid = document.getElementById(gridId);
    if (grid) {
        grid.classList.toggle("bulk-mode", on);
        var cards = grid.querySelectorAll(".card");
        for (var i = 0; i < cards.length; i++) {
            cards[i].classList.remove("selected-for-delete");
        }
    }
}

function updateTmpBulkCount() {
    var countEl = document.getElementById("tmp-delete-count");
    if (countEl) countEl.textContent = "(" + tmpBulkSelected.length + ")";
}

// Map each selected card's "name||cat" key to its on-disk folder path,
// read straight from the DOM or record so we can consult the busy-set and delete accurately.
function getSelectedCardFolders() {
    var map = {};
    var grid = document.getElementById(getActiveGridId());
    if (!grid) return map;
    var cards = grid.querySelectorAll(".card.selected-for-delete");
    for (var i = 0; i < cards.length; i++) {
        var c = cards[i];
        var key = c.dataset.file + "||" + c.dataset.cat;
        var fld = (c.dataset.folder || "").replace(/\\/g, "/");
        if (!fld) {
            var rec = _findUITemplateRecord(c.dataset.file, c.dataset.cat);
            if (rec && rec.folderPath) fld = rec.folderPath.replace(/\\/g, "/");
        }
        map[key] = fld;
    }
    return map;
}

function performTmpBulkDelete() {
    if (tmpBulkSelected.length === 0) return;

    // Partition selection: defer any card whose folder is mid-render so a
    // background preview can't be wiped out from under itself.
    var folderMap = getSelectedCardFolders();
    var deletable = [];
    var deferred = [];
    for (var s = 0; s < tmpBulkSelected.length; s++) {
        var key = tmpBulkSelected[s];
        var folder = folderMap[key];
        if (folder && isFolderBusy(folder)) {
            deferred.push(key.split("||")[0]);
        } else {
            deletable.push(key);
        }
    }

    if (deletable.length === 0) {
        showToast(deferred.length === 1
            ? "Asset is currently rendering a preview — try again in a moment"
            : "Selected assets are currently rendering previews — try again in a moment", "error");
        return;
    }

    var confirmMsg = "Are you sure you want to permanently delete these " + deletable.length +
        " item" + (deletable.length === 1 ? "" : "s") + " and their assets?";
    if (!confirm(confirmMsg)) return;

    // Collect names and categories of the deletable cards
    var ids = [];
    var cats = [];
    for (var i = 0; i < deletable.length; i++) {
        var parts = deletable[i].split("||");
        ids.push(parts[0]);
        cats.push(parts[1]);
    }

    // Group the selection by OWNING library root: the host resolves every
    // folder against the single root of one call, and cards may belong to
    // any configured root. Sending the global rootPath for a foreign-root
    // card deletes nothing while the host reports idempotent success — so
    // each distinct owning root gets its own call, and a card whose owning
    // root cannot be resolved counts as failed, never as deleted.
    var configuredRoots = resolveStartupPaths();
    var groups = []; // [{ root, ids: [], cats: [], folders: [] }]
    var unresolvedRoot = 0;
    for (var g = 0; g < ids.length; g++) {
        var cardFolder = (folderMap[deletable[g]] || "").replace(/\\/g, "/");
        var owner = "";
        if (cardFolder === "" && configuredRoots.length === 1) {
            // A card with no resolvable folder in a single-root library can
            // only live under that root — the historical behavior.
            owner = configuredRoots[0];
        } else {
            for (var cr = 0; cr < configuredRoots.length; cr++) {
                var normOwner = startupNormalizePath(configuredRoots[cr]);
                if (normOwner !== "" && cardFolder.indexOf(normOwner + "/") === 0) { owner = configuredRoots[cr]; break; }
            }
        }
        if (!owner) { unresolvedRoot++; continue; }
        var group = null;
        for (var gg = 0; gg < groups.length; gg++) {
            if (startupNormalizePath(groups[gg].root) === startupNormalizePath(owner)) { group = groups[gg]; break; }
        }
        if (!group) { group = { root: owner, ids: [], cats: [], folders: [] }; groups.push(group); }
        group.ids.push(ids[g]);
        group.cats.push(cats[g]);
        group.folders.push(cardFolder);
    }

    if (groups.length === 0) {
        showToast("Could not resolve the library root for the selected items — nothing deleted", "error");
        return;
    }

    var agg = { ok: 0, failed: unresolvedRoot, done: 0 };
    for (var q = 0; q < groups.length; q++) {
        (function (grp) {
            csInterface.evalScript(
                'deleteTemplatesBulk("' +
                encodeBridge(grp.ids.join("||")) + '","' +
                encodeBridge(grp.cats.join("||")) + '","' +
                encodeBridge(grp.root) + '","' +
                encodeBridge(grp.folders.join("||")) + '")',
                function (resultHex) {
                    var result = decodeBridge(resultHex);

                    // New JSON contract: { ok:Number, failed:[ids], error? }.
                    // Stays backward-compatible with the legacy "true"/"false" strings.
                    var okCount = 0;
                    var failedCount = 0;
                    var failedIds = [];
                    if (result === "true") {
                        okCount = grp.ids.length;
                    } else if (result === "false" || !result) {
                        failedCount = grp.ids.length;
                        failedIds = grp.ids.slice();
                    } else {
                        try {
                            var parsed = JSON.parse(result);
                            okCount = (typeof parsed.ok === "number") ? parsed.ok : 0;
                            failedIds = (parsed.failed && parsed.failed.length) ? parsed.failed : [];
                            failedCount = failedIds.length;
                        } catch (eJ) {
                            // Unparseable response — report as failure rather than lie success.
                            failedCount = grp.ids.length;
                            failedIds = grp.ids.slice();
                            console.error("[CompSaver] bulk delete: bad response:", result);
                        }
                    }

                    agg.ok += okCount;
                    agg.failed += failedCount;

                    // Remove from UI optimistically without hitting disk
                    for (var k = 0; k < grp.ids.length; k++) {
                        if (failedIds.indexOf(grp.ids[k]) === -1 && result !== "false" && result) {
                            removeUITemplate(grp.ids[k], grp.cats[k], grp.folders[k]);
                        }
                    }

                    // Owned_Mutation: at least one delete succeeded under this root.
                    if (okCount > 0) csBumpRootGeneration(grp.root);

                    agg.done++;
                    if (agg.done !== groups.length) return;

                    var msgParts = [];
                    if (agg.ok > 0) msgParts.push("Deleted " + agg.ok + " item" + (agg.ok === 1 ? "" : "s"));
                    if (agg.failed > 0) msgParts.push(agg.failed + " could not be removed because " + (agg.failed === 1 ? "it is" : "they are") + " in use");
                    if (unresolvedRoot > 0) msgParts.push(unresolvedRoot + " had no resolvable library root");
                    if (deferred.length > 0) msgParts.push(deferred.length + " skipped (rendering)");

                    var toastType = (agg.failed > 0 || unresolvedRoot > 0 || deferred.length > 0) ? "error" : "success";
                    showToast(msgParts.length ? msgParts.join(", ") : "Nothing deleted", toastType);

                    setTmpBulkMode(false);
                }
            );
        })(groups[q]);
    }
}

function importCurrentCardToTimeline(card) {
    if (!card) return;

    var section = currentSection;
    var normSection = typeof getTemplateSection === "function" ? getTemplateSection({ section: section }) : section.toLowerCase();
    var name = card.dataset.file;
    var cat = card.dataset.cat;
    var cardFolder = (card.dataset.folder || "").replace(/\\/g, "/");

    // Route the whole action through the batching, cache-first Import_Engine.
    // A single card is a batch of one; the engine still issues exactly one
    // Bridge_Call (or zero when the result is already cached).
    importTemplates(
        {
            // Transport: EXACTLY ONE Bridge_Call carrying the batch payload,
            // routed through the timeout-guarded wrapper. Without it a host call
            // that never returns left the card stuck with .importing, no toast
            // and no way to retry, and a CEP "EvalScript error." sentinel was
            // fed to decodeBridge as if it were hex. callHost owns the settled
            // latch, the timeout and the sentinel classification, and always
            // settles — so the result callback (which clears .importing) always
            // runs. It already decoded the reply, hence the identity `decode`.
            callHost: function (payloadHex, cb) {
                callHost('importBatch("' + payloadHex + '")', { timeoutMs: 120000 })
                    .then(function (outcome) {
                        if (outcome && outcome.ok) { cb(outcome.result); return; }
                        var reason = (outcome && outcome.timedOut)
                            ? "Import timed out — After Effects did not respond"
                            : ((outcome && outcome.error) || "Import failed");
                        cb(JSON.stringify({ perTemplate: [], error: reason }));
                    });
            },
            // The transport above owns the timeout; this is only the engine's
            // last-resort backstop, set above it so it never pre-empts a live call.
            timeoutMs: 130000,
            // Cache-first hook: resolves pre-computed metadata if available
            resolveCached: function (template) {
                var cache = typeof getMetadataCache === "function" ? getMetadataCache() : null;
                if (!cache) return null;

                // Use the card's actual folder path if available (fixes hex-encoded
                // FastMediaEngine folder name mismatch), otherwise reconstruct.
                var folderPath = template.folderPath;
                if (!folderPath) {
                    var fsName = template.name;
                    var safeCat = typeof getSafeName === "function" ? getSafeName(template.category) : template.category;
                    var safeId = typeof generateTemplateId === "function" ? generateTemplateId(fsName) : fsName;
                    var normRoot = typeof normalizeFolderPath === "function" ? normalizeFolderPath(template.sourcePath) : template.sourcePath;
                    var normSec = typeof normalizeSectionName === "function" ? normalizeSectionName(template.section) : template.section;
                    folderPath = normRoot + "/" + normSec + "/" + safeCat + "/" + safeId;
                }
                template.folderPath = folderPath;

                var entry = cache.getEntry(folderPath);
                if (entry && entry.metadata) {
                    template.metadata = entry.metadata;
                }
                return null;
            },
            // "Import started" feedback (Req 6.2): instant scale-press + class.
            onStarted: function () {
                card.classList.add("importing");
                var originalTransform = card.style.transform || "";
                card.style.transform = "scale(0.96)";
                setTimeout(function () { card.style.transform = originalTransform; }, 80);
            },
            encode: encodeBridge,
            // callHost already decoded the host reply.
            decode: function (s) { return s == null ? "" : "" + s; }
        },
        {
            rootPath: getTemplateSourcePath(name, cat),
            templates: [{
                id: name,
                name: name,
                category: cat,
                section: normSection,
                sourcePath: getTemplateSourcePath(name, cat),
                folderPath: cardFolder || ""
            }]
        },
        function (result) {
            card.classList.remove("importing");
            // One bounded timing line per import (host-reported phases) so
            // import latency is measurable in the field without any disk
            // logging. totalMs/decodeMs/templates[] come from importBatch.
            if (result && result.timings) {
                try {
                    console.log("[CompSaver import]", name,
                        "total=" + Math.round(result.timings.totalMs || 0) + "ms",
                        "decode=" + Math.round(result.timings.decodeMs || 0) + "ms",
                        "perTemplate=" + (result.timings.templates || []).map(function (ms) {
                            return Math.round(ms) + "ms";
                        }).join(","));
                } catch (eTL) { }
            }
            var entry = (result && result.perTemplate && result.perTemplate[0]) || null;
            var ok = entry && (entry.status === "imported" || entry.status === "cached");
            if (ok) {
                csBumpRootGeneration(getTemplateSourcePath(name, cat));
                card.classList.add("imported");
                setTimeout(function () { card.classList.remove("imported"); }, 600);
                if (section === SECTIONS.TEXT_PROPS) showToast("Applied to text", "success");
                else if (section === SECTIONS.COMP) showToast("Composition imported", "success");
                else showToast("Imported successfully", "success");
            } else {
                showToast((entry && entry.reason) || "Import failed", "error");
            }
        }
    );
}

function openIconRightClickPopup(card, clientX, clientY) {
    var existing = document.querySelectorAll(".icon-more-popup");
    for (var i = 0; i < existing.length; i++) existing[i].remove();

    var isFav = card.classList.contains("is-fav") ||
        card.querySelector(".btn-favorite.active") ||
        card.querySelector(".ic-star.ia-active");
    var favLabel = isFav ? "Unfavorite" : "Favorite";

    var popup = document.createElement("div");
    popup.className = "icon-more-popup open";
    popup.innerHTML =
        '<div class="icon-more-item" data-action="favorite">' + favLabel + '</div>' +
        '<div class="icon-more-item" data-action="rename">Rename</div>' +
        '<div class="icon-more-item" data-action="move">Move to...</div>' +
        '<div class="icon-more-item danger" data-action="delete">Delete</div>';

    var popupW = 110, popupH = 115;
    var left = clientX + 4, top = clientY + 4;
    if (left + popupW > window.innerWidth - 4) left = clientX - popupW - 4;
    if (top + popupH > window.innerHeight - 4) top = clientY - popupH - 4;
    if (left < 4) left = 4;
    if (top < 4) top = 4;

    popup.style.cssText =
        "position:fixed;width:" + popupW + "px;" +
        "left:" + left + "px;top:" + top + "px;z-index:9999;";
    document.body.appendChild(popup);

    popup.querySelector('[data-action="favorite"]').addEventListener("click", function () {
        popup.remove(); toggleFavorite(card);
    });
    popup.querySelector('[data-action="rename"]').addEventListener("click", function () {
        popup.remove(); openRenameModal(card);
    });
    popup.querySelector('[data-action="move"]').addEventListener("click", function () {
        popup.remove(); openMoveModal(card);
    });
    popup.querySelector('[data-action="delete"]').addEventListener("click", function () {
        popup.remove(); deleteTemplate(card.dataset.file, card.dataset.cat, card.dataset.folder);
    });

    setTimeout(function () {
        var closer = function (e) {
            if (!popup.contains(e.target)) {
                popup.remove();
                document.removeEventListener("mousedown", closer);
            }
        };
        document.addEventListener("mousedown", closer);
    }, 10);
}

function openRenameModal(card) {
    renameTargetCard = card;
    var input = DOM["rename-input"];
    if (!input) return;
    input.value = card.dataset.file;
    if (DOM["rename-modal"]) {
        DOM["rename-modal"].classList.add("open");
        FocusTrap.activate(DOM["rename-modal"]);
    }
    setTimeout(function () { input.focus(); input.select(); }, 100);
}

function closeRenameModal() {
    FocusTrap.deactivate();
    if (DOM["rename-modal"]) DOM["rename-modal"].classList.remove("open");
    if (DOM["rename-input"]) DOM["rename-input"].value = "";
    renameTargetCard = null;
}

function confirmRename() {
    if (!renameTargetCard) return;
    var newName = (DOM["rename-input"].value || "").trim();
    var oldName = renameTargetCard.dataset.file;
    var cat = renameTargetCard.dataset.cat;
    if (!newName || newName === oldName) { closeRenameModal(); return; }
    closeRenameModal();
    csInterface.evalScript(
        'renameTemplatePath("' +
        encodeBridge(oldName) + '","' +
        encodeBridge(newName) + '","' +
        encodeBridge(cat) + '","' +
        encodeBridge(getTemplateSourcePath(oldName, cat)) + '")',
        function (resultHex) {
            var raw = (typeof resultHex === "string") ? resultHex.trim() : resultHex;
            if (!raw || (typeof raw === "string" && raw.indexOf("EvalScript error.") !== -1)) {
                showToast('Rename failed for "' + oldName + '"', "error");
                return;
            }
            // The return is an encodeBridge hex payload: renameTemplatePath
            // answers "true"/"false", so decode first — the raw hex of "false"
            // is a non-empty string that must not read as success.
            var decoded = decodeBridge(raw);
            if (decoded !== "true") {
                showToast('Rename failed for "' + oldName + '"' + (decoded ? " (" + decoded + ")" : ""), "error");
                return;
            }
            showToast('Renamed to "' + newName + '"', "success");
            csBumpRootGeneration(getTemplateSourcePath(oldName, cat));
            var newId = typeof generateTemplateId === "function" ? generateTemplateId(newName) : newName;
            patchUITemplate(oldName, cat, { name: newName, id: newId }, newName, undefined);
        }
    );
}

function openMoveModal(card) {
    moveTargetCard = card;
    var cats = [];
    var section = getSectionTemplates();
    for (var i = 0; i < section.length; i++) {
        var c = section[i].category;
        if (c && cats.indexOf(c) === -1) cats.push(c);
    }
    updateMoveSelect(cats, card.dataset.cat);
    if (DOM["move-modal"]) {
        DOM["move-modal"].classList.add("open");
        FocusTrap.activate(DOM["move-modal"]);
    }
}

function closeMoveModal() {
    FocusTrap.deactivate();
    if (DOM["move-modal"]) DOM["move-modal"].classList.remove("open");
    if (DOM["move-cat-select-wrapper"]) DOM["move-cat-select-wrapper"].classList.remove("open");
    moveTargetCard = null;
    selectedMoveCat = "";
}

function confirmMove() {
    if (!moveTargetCard || !selectedMoveCat) { closeMoveModal(); return; }
    var name = moveTargetCard.dataset.file;
    var oldCat = moveTargetCard.dataset.cat;
    var newCat = selectedMoveCat;
    closeMoveModal();
    csInterface.evalScript(
        'moveTemplatePath("' +
        encodeBridge(name) + '","' +
        encodeBridge(oldCat) + '","' +
        encodeBridge(newCat) + '","' +
        encodeBridge(getTemplateSourcePath(name, oldCat)) + '")',
        function (resultHex) {
            var raw = (typeof resultHex === "string") ? resultHex.trim() : resultHex;
            if (!raw || (typeof raw === "string" && raw.indexOf("EvalScript error.") !== -1)) {
                showToast("Move to " + newCat + " failed", "error");
                return;
            }
            // The return is an encodeBridge hex payload: moveTemplatePath
            // answers "true"/"false", so decode first — the raw hex of "false"
            // is a non-empty string that must not read as success.
            var decoded = decodeBridge(raw);
            if (decoded !== "true") {
                showToast("Move to " + newCat + " failed" + (decoded ? " (" + decoded + ")" : ""), "error");
                return;
            }
            showToast("Moved to " + newCat, "info");
            csBumpRootGeneration(getTemplateSourcePath(name, oldCat));
            patchUITemplate(name, oldCat, { category: newCat }, undefined, newCat);
        }
    );
}

function openSaveModal() {
    if (currentMainModule !== MODULES.TEMPLATES) return;
    var nameInput = DOM["input-name"];
    if (!nameInput) return;
    nameInput.value = "";

    selectedCatValue = (currentCategory !== "All" && currentCategory !== "Favorites")
        ? currentCategory : "Uncategorized";

    if (DOM["input-new-cat"]) DOM["input-new-cat"].value = "";
    if (DOM["save-dest-info"]) DOM["save-dest-info"].textContent = "Detecting selection...";

    var btns = document.querySelectorAll(".save-type-btn");
    for (var i = 0; i < btns.length; i++) {
        btns[i].disabled = false;
        btns[i].style.opacity = "1";
        btns[i].classList.remove("active");
    }

    if (DOM["save-modal"]) {
        DOM["save-modal"].classList.add("open");
        FocusTrap.activate(DOM["save-modal"]);
    }

    detectedSaveType = "";
    saveCapabilities = null;
    selectedSaveType = SECTIONS.COMP;

    csInterface.evalScript("getSaveCapabilities()", function (hexResult) {
        var json = decodeBridge(hexResult);
        var caps = null;

        try { caps = JSON.parse(json); } catch (e) {
            console.error("[CompSaver] Caps parse:", e, json);
        }

        if (!caps || caps.primary === "error") {
            var errMsg = (caps && caps.message) ? caps.message : "Detection failed.";
            if (DOM["save-dest-info"]) DOM["save-dest-info"].textContent = errMsg;
            showToast(errMsg, "error");
            var dbtns = document.querySelectorAll(".save-type-btn");
            for (var k = 0; k < dbtns.length; k++) {
                dbtns[k].disabled = true;
                dbtns[k].style.opacity = "0.3";
                dbtns[k].style.cursor = "not-allowed";
            }
            return;
        }

        saveCapabilities = caps;
        detectedSaveType = caps.primary;
        if (DOM["save-dest-info"]) DOM["save-dest-info"].textContent = caps.message || rootPath;

        applyWallLogic();

        var autoType = caps.primary;
        if (caps.primary === SECTIONS.TEXT && currentSection === SECTIONS.TEXT_PROPS) {
            autoType = SECTIONS.TEXT_PROPS;
        }
        setSaveType(autoType);

        var nameInput = DOM["input-name"];
        if (caps.suggestedName && nameInput && !nameInput.value) {
            nameInput.value = caps.suggestedName;
        }

        if (nameInput) {
            setTimeout(function () { nameInput.focus(); nameInput.select(); }, 100);
        }
    });
}

function closeSaveModal() {
    FocusTrap.deactivate();
    if (DOM["save-modal"]) DOM["save-modal"].classList.remove("open");
    if (DOM["input-name"]) DOM["input-name"].value = "";
    if (DOM["input-new-cat"]) DOM["input-new-cat"].value = "";
    if (DOM["cat-select-wrapper"]) DOM["cat-select-wrapper"].classList.remove("open");
    detectedSaveType = "";
    saveCapabilities = null;
}

// Per-card monotonic sequence backing the cache-busting token. Requirement 3.3
// (Property 9) demands each thumbnail reference differ from the immediately
// previous reference for that card — even when two consecutive renders share a
// file modification time (same-second re-render, coarse mtime resolution). A
// plain `?v=<mtime>` cannot guarantee that; combining the mtime with a strictly
// increasing per-folder sequence does. Keyed by normalized folder path.
var _thumbCacheSeq = Object.create(null);

// Produce a cache-busting token for `normFolder` that is guaranteed to differ
// from the previous token issued for that same card. The optional `mtime`
// (milliseconds) is folded in for real cache correctness; the always-incrementing
// sequence guarantees uniqueness regardless of mtime resolution or ordering.
function nextThumbCacheToken(normFolder, mtime) {
    var key = normFolder || "";
    var seq = (_thumbCacheSeq[key] || 0) + 1;
    _thumbCacheSeq[key] = seq;
    var base = (typeof mtime === "number" && isFinite(mtime)) ? Math.floor(mtime) : Date.now();
    return base + "-" + seq;
}

// The one cache-busted display URL rule. `raw` is a forward-slashable disk
// path; `token` comes from nextThumbCacheToken. Kept in one place so the
// in-session refresh and the warm-paint derivation cannot drift apart.
function buildBustedThumbUrl(raw, token) {
    var fwd = ("" + (raw || "")).replace(/\\/g, "/");
    if (fwd === "") return "";
    if (fwd.charAt(0) === "/") fwd = fwd.substring(1);
    return "file:///" + encodeURI(fwd) + "?v=" + token;
}

// Refresh ONLY the saved template card's thumbnail image in place, using a
// cache-busting `?v=<token>` query so no stale cached image is displayed. The
// token always differs from the previous reference for the same card (see
// nextThumbCacheToken). Used when a deferred background thumbnail render lands.
// On a successful swap it also clears any prior failure indicator and marks the
// Library_Index entry `thumbStatus='ready'` (Req 3.3). Falls back to a no-op if
// the card is not currently in the DOM (a later template load picks it up).
function refreshCardThumbnail(folderPath, thumbPath) {
    try {
        var normFolder = ("" + folderPath).replace(/\\/g, "/");
        var mtime = null;
        try {
            var fsm = nfs();
            if (fsm && fsm.statSync) {
                var st = fsm.statSync(("" + thumbPath).replace(/\\/g, "/"));
                var mt = st.mtimeMs || (st.mtime && st.mtime.getTime());
                if (mt) mtime = mt;
            }
        } catch (eStat) { }

        var version = nextThumbCacheToken(normFolder, mtime);

        var url = buildBustedThumbUrl(thumbPath, version);

        // Reflect the completed thumbnail in the Library_Index without a scan:
        // clear the failed/placeholder state and record the rendered path.
        try {
            var li = (typeof getLibraryIndex === "function") ? getLibraryIndex() : null;
            if (li && li.has && li.has(normFolder) && li.patchEntry) {
                li.patchEntry(normFolder, { thumbStatus: "ready", thumbnailPath: ("" + thumbPath).replace(/\\/g, "/") });
            }
        } catch (eIdx) { }
        // The imperative DOM patch below fixes the CURRENT node, but every
        // re-render rebuilds markup from the model, and renderTemplateCardMarkup
        // reads `thumbnail`. Leaving it "" is why a rendered thumbnail reverted
        // to the placeholder on the next scroll or filter change.
        //
        // The two fields carry deliberately different shapes:
        //   thumbnailPath — the raw disk path, which is what an existsSync
        //                   probe wants (renderOptimisticCard reads it first)
        //   thumbnail     — the cache-busted file:/// URL. The renderer passes
        //                   an already-file:/// value through verbatim, so a
        //                   later re-render keeps the busting token instead of
        //                   emitting a bare URL CEF may answer from cache.
        for (var a = 0; a < allTemplates.length; a++) {
            if ((("" + (allTemplates[a].folderPath || "")).replace(/\\/g, "/")) === normFolder) {
                allTemplates[a].thumbStatus = "ready";
                allTemplates[a].thumbnailPath = ("" + thumbPath).replace(/\\/g, "/");
                allTemplates[a].thumbnail = url;
                // A middle-of-array field mutation changes neither the array
                // identity, its length, nor its first/last element, so
                // catalogSourceChanged cannot observe it. Patch the catalog
                // directly or virtualGrid keeps rendering the stale clone.
                if (typeof TemplateCatalog !== "undefined" && TemplateCatalog.patch) {
                    TemplateCatalog.patch(allTemplates[a]);
                }
                break;
            }
        }

        var cards = document.querySelectorAll(".card, .icon-card");
        for (var i = 0; i < cards.length; i++) {
            var c = cards[i];
            if (((c.dataset.folder || "").replace(/\\/g, "/")) !== normFolder) continue;

            c.dataset.thumb = url;
            var box = c.querySelector(".thumb-box") || c.querySelector(".icon-thumb");
            if (box) {
                var img = box.querySelector("img");
                if (img) {
                    img.src = url;
                } else {
                    var cls = c.classList.contains("icon-card") ? "" : "thumb-img";
                    box.innerHTML = '<img' + (cls ? ' class="' + cls + '"' : "") +
                        ' src="' + escapeAttr(url) + '" alt="" loading="lazy">';
                }
                // A successful render supersedes any earlier failure indicator.
                var badge = box.querySelector(".thumb-fail-badge");
                if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
            }
            c.classList.remove("thumb-failed");
            break;
        }
    } catch (e) {
        try { console.warn("[CompSaver] refreshCardThumbnail failed:", e); } catch (eL) { }
    }
}

// ── Optimistic card rendering ──────────────────────────────────────────────
// Feature: save-import-performance-redesign (Task 5.4 / Req 3.2, 3.5, 3.6).
// Render the just-saved template's card immediately after the essential save
// reports success, BEFORE its thumbnail exists. The card is inserted at the
// head of the Library_Index (position 0) and mirrored to the in-memory
// `allTemplates` so the canonical renderer emits a fully selectable/openable
// card — no full Library_Scan is performed (a re-render from memory is not a
// disk scan). When the rendered thumbnail file does not yet exist the entry is
// recorded with `thumbStatus='placeholder'` and the card shows the placeholder
// artwork the standard renderer already produces for a card with no thumbnail.
function renderOptimisticCard(template) {
    if (!template || typeof template !== "object") return null;
    try {
        var folderPath = ("" + (template.folderPath || "")).replace(/\\/g, "/");
        var thumbPath = ("" + (template.thumbnailPath || template.thumbnail || "")).replace(/\\/g, "/");

        // Does the rendered thumbnail file already exist on disk?
        var thumbExists = false;
        if (thumbPath) {
            try {
                var fsm = nfs();
                if (fsm && typeof fsm.existsSync === "function") {
                    thumbExists = fsm.existsSync(thumbPath);
                } else if (fsm && typeof fsm.statSync === "function") {
                    fsm.statSync(thumbPath);
                    thumbExists = true;
                }
            } catch (eStat) { thumbExists = false; }
        }
        var thumbStatus = thumbExists ? "ready" : "placeholder";
        var section = template.section || getTemplateSection(template);

        // 1) Insert into the persisted/in-memory Library_Index at the head (Req
        //    3.5 / Property 7). insertAtHead replaces any prior entry for the
        //    same folder in place, so re-saving never duplicates a card.
        try {
            var li = (typeof getLibraryIndex === "function") ? getLibraryIndex() : null;
            if (li && li.insertAtHead) {
                li.insertAtHead({
                    id: template.id || template.name,
                    name: template.name,
                    category: template.category,
                    section: section,
                    folderPath: folderPath,
                    thumbnailPath: thumbPath || undefined,
                    thumbStatus: thumbStatus,
                    favorite: !!template.favorite
                });
            }
        } catch (eIdx) {
            try { console.warn("[CompSaver] renderOptimisticCard: index insert failed:", eIdx); } catch (eL) { }
        }

        // 2) Mirror into `allTemplates` at the head so the canonical renderer
        //    includes the new card. A placeholder card carries an empty
        //    `thumbnail` so renderCards emits its standard placeholder artwork.
        var tplId = template.id || (typeof generateTemplateId === "function" ? generateTemplateId(template.name) : template.name);
        var tpl = {
            id: tplId,
            name: template.name,
            category: template.category,
            section: section,
            type: template.type || section,
            folderPath: folderPath,
            sourcePath: template.sourcePath || (typeof rootPath !== "undefined" ? rootPath : ""),
            thumbnail: thumbExists ? thumbPath : "",
            favorite: !!template.favorite,
            thumbStatus: thumbStatus
        };
        if (template.previewPath) tpl.previewPath = template.previewPath;
        if (template.previewMtime) tpl.previewMtime = template.previewMtime;

        for (var i = allTemplates.length - 1; i >= 0; i--) {
            if (folderPath &&
                (("" + (allTemplates[i].folderPath || "")).replace(/\\/g, "/")) === folderPath) {
                var replaced = allTemplates.splice(i, 1)[0];
                if (replaced && typeof TemplateCatalog !== "undefined") TemplateCatalog.remove(replaced);
            }
        }
        allTemplates.unshift(tpl);
        if (typeof TemplateCatalog !== "undefined") TemplateCatalog.patch(tpl);
        markTemplatesDirty();              // S7 — free: both the length and first-element probes already fire

        // 3) Re-render the active section from memory (NOT a Library_Scan) so
        //    the optimistic card appears at the head, selectable and openable.
        if (typeof filterAndRender === "function") filterAndRender();
        try { if (typeof updateCount === "function") updateCount(); } catch (eC) { }

        return tpl;
    } catch (e) {
        try { console.warn("[CompSaver] renderOptimisticCard failed:", e); } catch (eL) { }
        return null;
    }
}

// ── Card failure indicator ─────────────────────────────────────────────────
// Feature: save-import-performance-redesign (Task 5.4 / Req 3.4).
// Called when a thumbnail render has exhausted its retries. The placeholder
// thumbnail and the Library_Index entry are BOTH retained (never removed); the
// entry is marked `thumbStatus='failed'` and a visible failure badge is added
// to the single affected card. No full Library_Scan is performed.
function markCardFailed(folderPath) {
    try {
        var normFolder = ("" + folderPath).replace(/\\/g, "/");

        // Retain the entry; record the failed state in the Library_Index and
        // the in-memory mirror without a scan.
        try {
            var li = (typeof getLibraryIndex === "function") ? getLibraryIndex() : null;
            if (li && li.has && li.has(normFolder) && li.patchEntry) {
                li.patchEntry(normFolder, { thumbStatus: "failed" });
            }
        } catch (eIdx) { }
        for (var a = 0; a < allTemplates.length; a++) {
            if ((("" + (allTemplates[a].folderPath || "")).replace(/\\/g, "/")) === normFolder) {
                allTemplates[a].thumbStatus = "failed";
                markTemplatesDirty();      // S6 — no catalog mirror here at all; fires on terminal render failure, not on every success
                break;
            }
        }

        // Add a visible failure indicator to the single card, retaining its
        // placeholder artwork (the thumbnail image is left untouched).
        var cards = document.querySelectorAll(".card, .icon-card");
        for (var i = 0; i < cards.length; i++) {
            var c = cards[i];
            if ((("" + (c.dataset.folder || "")).replace(/\\/g, "/")) !== normFolder) continue;

            c.classList.add("thumb-failed");
            var box = c.querySelector(".thumb-box") || c.querySelector(".icon-thumb");
            if (box && !box.querySelector(".thumb-fail-badge")) {
                try {
                    if (window.getComputedStyle && getComputedStyle(box).position === "static") {
                        box.style.position = "relative";
                    }
                } catch (eP) { box.style.position = "relative"; }

                var badge = document.createElement("div");
                badge.className = "thumb-fail-badge";
                badge.title = "Thumbnail render failed";
                badge.setAttribute("aria-label", "Thumbnail render failed");
                badge.style.cssText =
                    "position:absolute;top:4px;right:4px;z-index:3;" +
                    "display:flex;align-items:center;justify-content:center;" +
                    "width:16px;height:16px;border-radius:50%;" +
                    "background:rgba(248,113,113,0.95);color:#fff;" +
                    "font-size:11px;font-weight:700;line-height:1;" +
                    "box-shadow:0 1px 3px rgba(0,0,0,0.4);pointer-events:none;";
                badge.textContent = "!";
                box.appendChild(badge);
            }
            break;
        }
    } catch (e) {
        try { console.warn("[CompSaver] markCardFailed failed:", e); } catch (eL) { }
    }
}

// ── Non-blocking background-activity indicator ─────────────────────────────
// Feature: save-import-performance-redesign (Task 5.1 / Req 5.3, 5.4).
// While Non_Essential_Save_Work is pending, the panel shows a small floating
// status pill. It is `pointer-events:none` and lives outside the save controls,
// so it is visible without ever blocking user input — save-triggering controls
// stay fully responsive (the save button is re-enabled the moment the essential
// save completes). A reference count keeps the pill up while any background
// work is still pending and removes it only when the last unit settles.
var _bgActivityCount = 0;
var _bgActivityEl = null;

function setBackgroundActivity(on, label) {
    try {
        if (on) {
            _bgActivityCount++;
            if (!_bgActivityEl) {
                _bgActivityEl = document.createElement("div");
                _bgActivityEl.className = "bg-activity-indicator";
                _bgActivityEl.setAttribute("role", "status");
                _bgActivityEl.setAttribute("aria-live", "polite");
                // Inline styles keep this self-contained and guaranteed
                // non-blocking regardless of stylesheet load order.
                _bgActivityEl.style.cssText =
                    "position:fixed;right:12px;bottom:12px;z-index:9999;" +
                    "pointer-events:none;display:flex;align-items:center;gap:8px;" +
                    "padding:6px 12px;border-radius:14px;font-size:11px;" +
                    "background:rgba(0,0,0,0.72);color:#fff;" +
                    "box-shadow:0 2px 8px rgba(0,0,0,0.35);opacity:0.92;";
                _bgActivityEl.innerHTML =
                    '<span class="bg-activity-dot" style="width:8px;height:8px;' +
                    "border-radius:50%;background:var(--accent,#4a9eff);" +
                    'display:inline-block;"></span>' +
                    '<span class="bg-activity-label"></span>';
                if (document.body) document.body.appendChild(_bgActivityEl);
            }
            var lbl = _bgActivityEl.querySelector(".bg-activity-label");
            if (lbl) lbl.textContent = label || "Finishing in background…";
        } else {
            _bgActivityCount = Math.max(0, _bgActivityCount - 1);
            if (_bgActivityCount === 0 && _bgActivityEl) {
                if (_bgActivityEl.parentNode) _bgActivityEl.parentNode.removeChild(_bgActivityEl);
                _bgActivityEl = null;
            }
        }
    } catch (e) {
        try { console.warn("[CompSaver] setBackgroundActivity failed:", e); } catch (eL) { }
    }
}

// Mark a template folder so its thumbnail is regenerated on the next template
// load. Called when a deferred thumbnail render fails; the CSS placeholder is
// retained until then. Best-effort — a failure here is non-fatal.
function markThumbnailForRegen(folderPath) {
    try {
        var fsm = nfs();
        if (!fsm || !fsm.promises) return;
        var marker = (("" + folderPath).replace(/\\/g, "/") + "/.needsthumb").replace(/\/+/g, "/");
        fsm.promises.writeFile(marker, "1", "utf8").catch(function () { });
    } catch (e) { }
}

// ── Save-time Metadata_Cache write (Task 3.5 / Req 11.1, 11.2) ──────
// On a successful essential save, record the template's expensive metadata
// plus its validity key into the Metadata_Cache so import/library-load can
// reuse it without rescanning template contents. The write is failure
// tolerant: persistTemplateMetadata never throws — on a cache-write failure it
// records the entry as absent so it is recomputed on next access — so the save
// completes regardless of the outcome here (Req 11.2, Property 31).
//
//   folderPath — the saved template folder (project.aep / meta.json live here)
//   metaObj    — the meta.json descriptor just written for the template
//   assets     — optional list of referenced asset descriptors ({ name, ... })
function cacheTemplateMetadataOnSave(folderPath, metaObj, assets) {
    try {
        if (typeof getMetadataCache !== "function" || typeof persistTemplateMetadata !== "function") return;
        var cache = getMetadataCache();
        if (!cache) return;

        metaObj = metaObj || {};
        var assetNames = [];
        if (assets && assets.length) {
            for (var i = 0; i < assets.length; i++) {
                var a = assets[i];
                if (a && a.name) assetNames.push(a.name);
            }
        }

        // Template_Metadata descriptor (design: Data Models → Template_Metadata).
        var metadata = {
            id: metaObj.id,
            name: metaObj.name,
            category: metaObj.category,
            section: metaObj.section,
            assets: assetNames,
            thumbnailPath: metaObj.thumbnail
                ? (normFolderPath(folderPath) + "/" + metaObj.thumbnail)
                : undefined
        };
        if (metaObj.dim) metadata.dimensions = metaObj.dim;
        if (metaObj.layerState) metadata.layerState = metaObj.layerState;

        // validityKey omitted -> derived from the folder's current on-disk state
        // at write time (Req 11.1). Failure is swallowed by the helper (Req 11.2).
        var res = persistTemplateMetadata({
            cache: cache,
            folderPath: folderPath,
            metadata: metadata,
            persist: function () {
                if (typeof saveMetadataCache === "function") {
                    saveMetadataCache();
                }
            }
        });
        if (res && !res.ok) {
            // Non-fatal: the entry is recorded as absent and will be recomputed
            // on next access. Surface for diagnostics only; the save still stands.
            console.warn("[CompSaver] Metadata_Cache write skipped (recompute on next access):", res.reason);
        }
    } catch (e) {
        // Belt-and-suspenders: nothing in the metadata-cache write may abort a
        // completed save (Req 11.2).
        console.warn("[CompSaver] Metadata_Cache write error (ignored):", e);
    }
}

function confirmSave() {
    var name = (DOM["input-name"].value || "").trim();
    var newCat = (DOM["input-new-cat"].value || "").trim();
    var cat = newCat || selectedCatValue || "Uncategorized";

    if (!name) { showToast("Please enter a name", "error"); return; }

    var saveBtn = DOM["btn-confirm-save"];
    if (!saveBtn) return;

    var saveType = selectedSaveType;
    if (!saveType) { showToast("No save type selected", "error"); return; }

    var jsxFunc = "";
    var typeArg = "";

    if (saveType === SECTIONS.COMP) jsxFunc = "saveActiveComp";
    else if (saveType === SECTIONS.LAYER) jsxFunc = "saveActiveLayer";
    else if (saveType === SECTIONS.TEXT) jsxFunc = "saveActiveText";
    else if (saveType === SECTIONS.TEXT_PROPS) jsxFunc = "saveActiveTextProperties";
    else if (saveType === SECTIONS.FOOTAGE) jsxFunc = "saveActiveFootage";
    else if (saveType === SECTIONS.EFFECT) jsxFunc = "saveActiveEffect";
    else if (saveType === "png") {
        // Host-side monolithic image save: savePNGOnly copies the source image,
        // writes thumbnail.png + meta.json and finalizes the old folder in ONE
        // evalScript. The previous getPNGSaveInfo + panel-side Node copy broke
        // whenever Node fs was unavailable/failed — leaving a blank card and no
        // folder on disk ("Image folder not found!" on import).
        jsxFunc = "savePNGOnly";
        var targetImgSec = (currentSection === SECTIONS.OVERLAY) ? SECTIONS.OVERLAY : SECTIONS.ICON;
    } else {
        showToast("Invalid save type: " + saveType, "error");
        return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "...";

    csInterface.evalScript(
        'validateSaveRequest("' + encodeBridge(saveType) + '")',
        function (validationHex) {
            var validation = decodeBridge(validationHex);

            if (!validation) {
                saveBtn.disabled = false;
                saveBtn.textContent = "Save";
                showToast("Cannot communicate with AE", "error");
                return;
            }

            if (validation !== "true") {
                saveBtn.disabled = false;
                saveBtn.textContent = "Save";
                showToast(validation, "error");
                return;
            }

            var nHex = encodeBridge(name);
            var cHex = encodeBridge(cat);
            var rHex = encodeBridge(savePath || rootPath);

            // Pass the section being saved. The host used to default to "comp" and
            // so ran the existence check against the wrong section for every
            // layer/text/footage/effect save.
            var existsSection = (saveType === "png") ? targetImgSec : saveType;
            var sHex = encodeBridge(existsSection);

            // Routed through the timeout-guarded callHost: it owns the settled
            // latch, the timeout and the sentinel/decode-failure classification,
            // and it always settles, so the save can never stall on this probe.
            // The order is unchanged - validateSaveRequest -> itemExists -> runSave().
            callHost('itemExists("' + nHex + '","' + cHex + '","' + rHex + '","' + sHex + '")')
                .then(function (outcome) {
                    // The host answers with an explicit envelope now
                    // (exists/id/section). It used to answer with the matched
                    // FOLDER NAME, which this call site compared against the
                    // literal "true" — never equal, so `exists` was constant false.
                    var info = { exists: false, id: "" };
                    if (outcome && outcome.ok && outcome.result &&
                        ("" + outcome.result).charAt(0) === "{") {
                        try { info = JSON.parse(outcome.result); } catch (eJson) { info = { exists: false, id: "" }; }
                    }
                    if (!info) info = { exists: false, id: "" };
                    var exists = info.exists === true;

                    if (exists) {
                        if (Settings.get("library.confirmOverwrite")) {
                            var ok = confirm('"' + name + '" already exists. Overwrite?');
                            if (!ok) {
                                saveBtn.disabled = false;
                                saveBtn.textContent = "Save";
                                return;
                            }
                        }
                    }

                    // The id of the folder that ACTUALLY exists, so the background
                    // finalizer's .fav preservation and old-folder removal operate
                    // on a real path instead of a name that may not match it.
                    var oldId = exists ? (info.id || generateTemplateId(name)) : "";
                    var oldIdHex = encodeBridge(oldId);

                    closeSaveModal();
                    saveBtn.textContent = "Saving...";

                    var runSave = function () {
                        showToast("Saving template (reducing & restoring project)...", "info");

                        // Performance Optimization: Defer heavy ExtendScript execution by 80ms
                        // to let the CEP panel close the modal and render the toast smoothly without freezing.
                        setTimeout(function () {
                            var scriptCall = "";
                            if (saveType === "png") {
                                // savePNGOnly(nHex, cHex, rHex, typeHex, oldIdHex) — the
                                // image section is the 4th arg (other savers take it last).
                                scriptCall = jsxFunc + '("' + nHex + '","' + cHex + '","' + rHex + '","' + encodeBridge(targetImgSec) + '","' + oldIdHex + '")';
                            } else {
                                scriptCall = jsxFunc + '("' + nHex + '","' + cHex + '","' + rHex + '","' + oldIdHex + '"' + typeArg + ")";
                            }

                            // ── Async save controller (Task 5.1 / Req 1.3–1.6, 5.3, 5.4, 5.7) ──
                            // parseEssential classifies the decoded host reply into an
                            // EssentialSaveResult; scheduleBackground runs every unit of
                            // Non_Essential_Save_Work OFF the blocking path, reporting
                            // failures (which keep the retained essential result) and
                            // settling the background-activity indicator when done.
                            var parseEssential = function (decoded) {
                                var result = decoded == null ? "" : "" + decoded;
                                if (saveType === "png") {
                                    // savePNGOnly is monolithic: by the time it replies
                                    // "true" the folder, source image, thumbnail.png and
                                    // meta.json are already on disk (host-side).
                                    if (result.indexOf("ERROR:") === 0) return { ok: false, error: result.substring(6) };
                                    if (result === "true") return { ok: true, kind: "png" };
                                    return { ok: false, error: result || "Empty response from After Effects" };
                                }
                                if (result) {
                                    if (result.indexOf("{") === 0) {
                                        try {
                                            var resObj = JSON.parse(result);
                                            if (resObj && resObj.ok) return { ok: true, kind: "assets", resObj: resObj };
                                            return { ok: false, error: (resObj && resObj.error) || "Save failed" };
                                        } catch (eJSON) {
                                            return { ok: false, error: "JSON Parse Error: " + eJSON.toString() };
                                        }
                                    }
                                    if (result === "true") return { ok: true, kind: "monolithic" };
                                    return { ok: false, error: result };
                                }
                                return { ok: false, error: "Empty response from After Effects" };
                            };

                            var scheduleBackground = function (essential, hooks) {
                                if (essential.kind === "png") {
                                    // Host-side monolithic save (savePNGOnly) already wrote the
                                    // source image, thumbnail.png, meta.json and finalized the
                                    // old folder inside the essential evalScript. The only
                                    // remaining work is Node-free: flip the optimistic card's
                                    // placeholder to the on-disk thumbnail.
                                    var pngSec = (targetImgSec === "overlay" || targetImgSec === "element") ? "overlay" : "icon";
                                    // The id segment is derived with generateTemplateId, exactly as
                                    // the host does, so the panel-derived folderPath matches the
                                    // folder the host actually created (F5e / Bug 1.26).
                                    var pngFolder = ((savePath || rootPath).replace(/\\/g, "/") + "/" + pngSec + "/" + safeCategorySegment(cat) + "/" + generateTemplateId(name)).replace(/\/+/g, "/");
                                    setTimeout(function () {
                                        try {
                                            refreshCardThumbnail(pngFolder, pngFolder + "/thumbnail.png");
                                            showToast("Saved " + getSaveTypeLabel(saveType), "success");
                                        } catch (eThumb) {
                                            console.error("[CompSaver] png save thumbnail refresh failed:", eThumb);
                                            hooks.onWorkFailed("image thumbnail refresh", eThumb);
                                        }
                                        hooks.onAllSettled();
                                    }, 0);
                                    return;
                                }

                                var fs = nfs();
                                if (!fs) {
                                    hooks.onWorkFailed("asset finalization", "Node.js filesystem not available");
                                    hooks.onAllSettled();
                                    return;
                                }

                                if (essential.kind === "assets") {
                                    var resObj = essential.resObj;
                                    showToast("Saving template assets...", "info");

                                    setTimeout(async function () {
                                        try {
                                            var folderPath = resObj.folderPath;
                                            var assetsList = resObj.assetsList || [];
                                            var templateId = resObj.templateId;
                                            var oldId = resObj.oldId;

                                            if (assetsList.length > 0) {
                                                var assetsFolder = folderPath + "/assets";
                                                await fs.promises.mkdir(assetsFolder, { recursive: true });

                                                for (var i = 0; i < assetsList.length; i++) {
                                                    var asset = assetsList[i];
                                                    var dest = assetsFolder + "/" + asset.name;
                                                    try {
                                                        var srcStat = await fs.promises.stat(asset.fsPath);
                                                        var destStat = null;
                                                        try { destStat = await fs.promises.stat(dest); } catch (e) { }
                                                        if (destStat && destStat.size === srcStat.size) {
                                                            continue;
                                                        }
                                                    } catch (eStat) { }
                                                    await fs.promises.copyFile(asset.fsPath, dest);
                                                }
                                            }

                                            var now = new Date().toISOString();
                                            // Req 2.9: the composition format, captured host-side
                                            // BEFORE the reopen invalidated the item (F1). Validated
                                            // here so an unusable value becomes undefined, which
                                            // JSON.stringify omits — a legacy host result therefore
                                            // still produces exactly the previous document.
                                            var fmtW = (typeof resObj.width === "number" && resObj.width > 0)
                                                ? resObj.width : undefined;
                                            var fmtH = (typeof resObj.height === "number" && resObj.height > 0)
                                                ? resObj.height : undefined;
                                            var metaObj = {
                                                schemaVersion: 2,
                                                id: templateId,
                                                name: resObj.name,
                                                section: resObj.section || "comp",
                                                type: resObj.type || "comp",
                                                category: resObj.category,
                                                mainFile: "project.aep",
                                                thumbnail: "thumbnail.png",
                                                // Req 2.9: format fields a consumer can present
                                                // without opening the .aep. `dim` is the string field
                                                // parseMetaContent has always read and nothing wrote.
                                                width: fmtW,
                                                height: fmtH,
                                                dim: (fmtW !== undefined && fmtH !== undefined)
                                                    ? (fmtW + "x" + fmtH) : undefined,
                                                pixelAspect: (typeof resObj.pixelAspect === "number" && resObj.pixelAspect > 0)
                                                    ? resObj.pixelAspect : undefined,
                                                frameRate: (typeof resObj.frameRate === "number" && resObj.frameRate > 0)
                                                    ? resObj.frameRate : undefined,
                                                duration: (typeof resObj.duration === "number" && resObj.duration >= 0)
                                                    ? resObj.duration : undefined,
                                                hasFrames: false,
                                                frameCount: 0,
                                                createdAt: now,
                                                updatedAt: now
                                            };
                                            // Req 2.10: key off the SAME normalized value written
                                            // above, so a host result that omits `section` still
                                            // records assetsDir.
                                            if (metaObj.section === "comp") {
                                                metaObj.assetsDir = assetsList.length > 0 ? "assets/" : "";
                                            }
                                            if (resObj.type === "layer") {
                                                metaObj.layerCount = resObj.layerCount;
                                                metaObj.isAdjustment = !!resObj.isAdjustment;
                                                metaObj.is3D = !!resObj.is3D;
                                                metaObj.blendMode = resObj.blendMode;
                                                metaObj.label = resObj.label;
                                                // Full timeline state (switches + markers) for exact restore on import.
                                                if (resObj.layerState) metaObj.layerState = resObj.layerState;
                                                // Utility Pre-Comp: restored as a Composition reference on import.
                                                if (resObj.assetKind === "precomp") {
                                                    metaObj.assetKind = "precomp";
                                                    if (resObj.precompName) metaObj.precompName = resObj.precompName;
                                                }
                                            }
                                            if (resObj.type === "text" || resObj.type === "footage" || resObj.type === "text_props") {
                                                metaObj.layerCount = resObj.layerCount || 1;
                                            }
                                            if (resObj.type === "effect") {
                                                metaObj.effectCount = resObj.effectCount;
                                                metaObj.effectNames = resObj.effectNames;
                                                metaObj.saveMode = resObj.saveMode;
                                            }

                                            await fs.promises.writeFile(folderPath + "/meta.json", JSON.stringify(metaObj, null, 4), "utf8");

                                            // Persist expensive metadata + validity key to the
                                            // Metadata_Cache (Req 11.1); failure-tolerant (Req 11.2).
                                            cacheTemplateMetadataOnSave(folderPath, metaObj, assetsList);

                                            if (oldId && oldId !== templateId) {
                                                var sectionName = resObj.section || "comp";
                                                var safeCatName = getSafeName(resObj.category);
                                                var oldFolderPath = ((savePath || rootPath).replace(/\\/g, "/") + "/" + sectionName + "/" + safeCatName + "/" + oldId).replace(/\/+/g, "/");
                                                try {
                                                    var hasFav = await fs.promises.access(oldFolderPath + "/.fav").then(() => true).catch(() => false);
                                                    if (hasFav) {
                                                        await fs.promises.writeFile(folderPath + "/.fav", "1", "utf8");
                                                    }
                                                } catch (eFav) { }
                                                try {
                                                    await fs.promises.rm(oldFolderPath, { recursive: true, force: true });
                                                } catch (eRm) { }
                                            }

                                            var aepFileName = (saveType === SECTIONS.EFFECT) ? "preview.aep" : "project.aep";
                                            var aepPath = (folderPath.replace(/\\/g, "/") + "/" + aepFileName).replace(/\/+/g, "/");

                                            // ── Deferred background thumbnail ──────────────
                                            // The reduce-first host save no longer renders a
                                            // thumbnail inline; it signals needsThumbnail so the
                                            // client can render it in the background. A missing
                                            // needsThumbnail field means "no deferred thumbnail"
                                            // (back-compat) — no thumbnail job is scheduled.
                                            if (resObj.needsThumbnail === true) {
                                                var thumbPath = (folderPath.replace(/\\/g, "/") + "/thumbnail.png").replace(/\/+/g, "/");
                                                showToast("Generating thumbnail…", "info");
                                                // setTimeout(…, 0) yields to the event loop so the
                                                // panel paints and accepts input before the
                                                // (serialized) background render is enqueued.
                                                setTimeout(function () {
                                                    var enqueueFn = (typeof ThumbnailEngine !== "undefined" && ThumbnailEngine && typeof ThumbnailEngine.enqueue === "function")
                                                        ? ThumbnailEngine.enqueue
                                                        : TextAnim.enqueueThumbnailRender;
                                                    enqueueFn(aepPath, thumbPath, function (thumbErr) {
                                                        if (thumbErr) {
                                                            // Retain the CSS placeholder and mark the
                                                            // template for regeneration on next load;
                                                            // surface it as an identified background
                                                            // failure without touching the essential result.
                                                            console.warn("[CompSaver] Thumbnail render failed:", thumbErr);
                                                            markThumbnailForRegen(folderPath);
                                                            hooks.onWorkFailed("thumbnail render", thumbErr);
                                                        } else {
                                                            // Refresh ONLY the saved card, cache-busted.
                                                            refreshCardThumbnail(folderPath, thumbPath);
                                                        }
                                                    }, resObj.renderComp, resObj.renderFrame);
                                                }, 0);
                                            }

                                            showToast("Generating background preview...", "info");
                                            setTimeout(function () {
                                                TextAnim.enqueuePreviewRender(aepPath, name, function (err) {
                                                    if (err) {
                                                        console.warn("[CompSaver] Auto-preview failed:", err);
                                                        showToast("Saved " + getSaveTypeLabel(saveType) + " ✓ (preview will retry later)", "success");
                                                        hooks.onWorkFailed("preview render", err);
                                                    } else {
                                                        showToast("Saved " + getSaveTypeLabel(saveType) + " (Preview Ready)", "success");
                                                    }
                                                    // UI is optimistic; no loadTemplates needed.
                                                    hooks.onAllSettled();
                                                }, true);
                                            }, 500);
                                        } catch (errAsync) {
                                            console.error("[CompSaver async save error]", errAsync);
                                            hooks.onWorkFailed("asset finalization", errAsync);
                                            hooks.onAllSettled();
                                        }
                                    }, 0);
                                } else if (essential.kind === "monolithic") {
                                    // Monolithic JSX save path: ExtendScript already wrote the .aep,
                                    // assets, thumbnail and meta.json and returned "true". JS only
                                    // needs to kick off the background preview render, rebuilding the
                                    // .aep path the same way the JSX save built its target folder:
                                    // <root>/<section>/<safeCat>/<safeName>.
                                    showToast("Generating background preview...", "info");
                                    var folderNameT = isTextSection(saveType) ? "text" : saveType;
                                    var aepFileNameT = (saveType === SECTIONS.EFFECT) ? "preview.aep" : "project.aep";
                                    var folderPathT = ((savePath || rootPath).replace(/\\/g, "/") + "/" + folderNameT + "/" + getSafeName(cat) + "/" + generateTemplateId(name)).replace(/\/+/g, "/");
                                    var aepPathT = (folderPathT + "/" + aepFileNameT).replace(/\/+/g, "/");

                                    // The host already wrote meta.json for this monolithic save;
                                    // record the expensive metadata + validity key to the
                                    // Metadata_Cache from the data JS has (Req 11.1),
                                    // failure-tolerant (Req 11.2).
                                    cacheTemplateMetadataOnSave(folderPathT, {
                                        id: generateTemplateId(name),
                                        name: name,
                                        category: cat,
                                        section: folderNameT,
                                        thumbnail: "thumbnail.png"
                                    }, null);

                                    setTimeout(function () {
                                        TextAnim.enqueuePreviewRender(aepPathT, name, function (err) {
                                            if (err) {
                                                console.warn("[CompSaver] Auto-preview failed:", err);
                                                showToast("Saved " + getSaveTypeLabel(saveType) + " ✓ (preview will retry later)", "success");
                                                hooks.onWorkFailed("preview render", err);
                                            } else {
                                                showToast("Saved " + getSaveTypeLabel(saveType) + " (Preview Ready)", "success");
                                            }
                                            // UI is optimistic; no loadTemplates needed.
                                            hooks.onAllSettled();
                                        }, true);
                                    }, 500);
                                } else {
                                    // Unreachable: scheduleBackground only runs after an essential
                                    // success. Settle the indicator defensively.
                                    hooks.onAllSettled();
                                }
                            };

                            // Trigger the essential save over the async Bridge and drive the
                            // control-flow guarantees (loading exit, essential/background error
                            // indications, non-blocking activity indicator) through the controller.
                            runSaveController(
                                {
                                    callHost: callHost,
                                    buildEssentialCall: function () { return scriptCall; },
                                    parseEssential: parseEssential,
                                    // Exit the save loading state on essential completion regardless
                                    // of any pending Non_Essential_Save_Work (Req 1.3, 1.5).
                                    exitLoading: function () {
                                        saveBtn.disabled = false;
                                        saveBtn.textContent = "Save";
                                    },
                                    // Essential failure indication; the live project is untouched (Req 1.5, 5.6).
                                    setError: function (msg) { showToast(msg, "error"); },
                                    // Background failure indication that keeps the essential result (Req 1.6, 5.7).
                                    setBackgroundError: function (msg) { showToast(msg, "error"); },
                                    // Non-blocking background-activity indicator; save controls stay
                                    // responsive because loading already exited (Req 5.3, 5.4).
                                    showBackgroundActivity: function () { setBackgroundActivity(true, "Finishing save in background…"); },
                                    hideBackgroundActivity: function () { setBackgroundActivity(false); },
                                    scheduleBackground: scheduleBackground,
                                    onEssentialSuccess: function (parsed) {
                                        var optFolder = parsed.resObj ? parsed.resObj.folderPath : "";
                                        var optThumb = parsed.resObj ? (parsed.resObj.folderPath + "/thumbnail.png") : "";
                                        if (saveType === "png") {
                                            // savePNGOnly has already written the folder and
                                            // thumbnail.png by now; derive the same path it used
                                            // so the optimistic card points at the real assets.
                                            var optSec = (targetImgSec === "overlay" || targetImgSec === "element") ? "overlay" : "icon";
                                            optFolder = ((savePath || rootPath).replace(/\\/g, "/") + "/" + optSec + "/" + safeCategorySegment(cat) + "/" + generateTemplateId(name)).replace(/\/+/g, "/");
                                            optThumb = optFolder + "/thumbnail.png";
                                        }
                                        renderOptimisticCard({
                                            name: name,
                                            category: cat,
                                            section: (saveType === "png") ? optSec : saveType,
                                            type: (saveType === "png") ? optSec : saveType,
                                            sourcePath: savePath || rootPath,
                                            folderPath: optFolder,
                                            thumbnailPath: optThumb
                                        });
                                    }
                                },
                                { scriptCall: scriptCall }
                            );
                        }, 80);
                    };


                    runSave();
                });
        }
    );
}
