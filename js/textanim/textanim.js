// ============================================================
// textanim/textanim.js - Text Animation module + preview pipeline
// ------------------------------------------------------------
// Self-contained TextAnim IIFE: .ffx save/apply/import/bulk-delete,
// category tabs, hover previews, and the SHARED single-flight preview
// render pipeline (AE render -> PNG seq -> ffmpeg APNG) used by BOTH
// text presets and .aep templates. Depends on globals: showToast,
// csInterface, encodeBridge/decodeBridge, markFolderBusy/clearFolderBusy
// (core/state.js), loadTemplatesDebounced hook (core/state.js).
// main.js calls TextAnim.init()/load(); the card grid + save path use
// TextAnim.enqueuePreviewRender / enqueueThumbnailRender /
// attachHoverPreviews / previewApngPathFor.
// Loaded before main.js.
// ============================================================

// =========================================================
// TEXT ANIMATION MODULE  (Toolkit > Text 'T' tab)
// Self-contained, isolated from the Effects pipeline.
// Native .ffx save/apply via ExtendScript; Node fs for management.
// =========================================================
var TextAnim = (function () {
    var DIR = "";                 // resolved isolated text dir (presets/user_text)
    var presets = [];             // current scan results
    var initialized = false;
    var currentCategory = "All";
    var searchQuery = "";
    var bulkMode = false;
    var bulkSelected = [];
    var pendingSaveName = "";
    var pendingSaveCat = "My Presets";
    var FAV_KEY = "ta_text_favorites";
    var CATEGORIES = ["All", "Flicker", "Fade In", "Bounce", "My Presets"];

    // ── Node helpers ──────────────────────────────────────────────────
    function req() {
        try { if (typeof require !== "undefined") return require; } catch (e) { }
        try { if (typeof window !== "undefined" && window.require) return window.require; } catch (e2) { }
        return null;
    }
    function nfs() { var r = req(); return r ? r("fs") : null; }

    // ── Category → live-preview motion mapping ────────────────────────
    function motionForCategory(cat) {
        var c = ("" + (cat || "")).toLowerCase();
        if (c.indexOf("flicker") !== -1) return "flicker";
        if (c.indexOf("fade") !== -1) return "fade";
        if (c.indexOf("bounce") !== -1) return "bounce";
        return "default";
    }

    // ── Favorites (localStorage) ──────────────────────────────────────
    function getFavorites() {
        try { var s = localStorage.getItem(FAV_KEY); return s ? JSON.parse(s) : {}; }
        catch (e) { return {}; }
    }
    function setFavorite(file, on) {
        var map = getFavorites();
        if (on) map[file] = true; else delete map[file];
        try { localStorage.setItem(FAV_KEY, JSON.stringify(map)); } catch (e) { }
    }

    // ── Directory resolution (isolated: text_animations under library root) ──
    function getActiveTextDir() {
        var base = (typeof rootPath !== "undefined" && rootPath) ? rootPath : "";
        if (!base) {
            try {
                var stored = localStorage.getItem("compSaver_libraryPaths");
                if (stored) {
                    var parsed = JSON.parse(stored);
                    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]) {
                        base = parsed[0];
                    }
                }
            } catch (e) { }
        }
        if (base) {
            return base.replace(/\\/g, "/").replace(/\/+$/, "") + "/text_animations";
        }
        return "";
    }

    // ── Guarded Host Bridge Helper (30s timeout latch + decode protection) ──
    function callHostGuarded(script, cb, timeoutMs) {
        var ms = (typeof timeoutMs === "number" && timeoutMs > 0) ? timeoutMs : 30000;
        if (typeof callHost === "function") {
            callHost(script, { timeoutMs: ms }).then(function (outcome) {
                if (!outcome || !outcome.ok) {
                    var err = (outcome && outcome.timedOut) ? "timeout" : (outcome && outcome.error ? outcome.error : "EvalScript error.");
                    if (cb) cb(null, err);
                    return;
                }
                if (cb) cb(outcome.result, null);
            });
            return;
        }
        var settled = false;
        var timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            if (cb) cb(null, "timeout");
        }, ms);
        try {
            if (typeof csInterface !== "undefined" && csInterface && typeof csInterface.evalScript === "function") {
                csInterface.evalScript(script, function (raw) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (!raw || raw === "EvalScript error." || raw === "undefined") {
                        if (cb) cb(null, raw || "empty");
                        return;
                    }
                    var val = (typeof decodeBridge === "function") ? decodeBridge(raw) : raw;
                    if (cb) cb(val, null);
                });
            } else {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (cb) cb(null, "No CSInterface transport available");
            }
        } catch (e) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (cb) cb(null, String(e));
        }
    }

    function resolveDir(cb) {
        var expected = getActiveTextDir();
        if (expected) {
            if (DIR === expected) {
                if (cb) cb(DIR);
                return;
            }
            DIR = expected;
            callHostGuarded('taEnsureTextDir("' + encodeBridge(DIR) + '")', function () {
                if (cb) cb(DIR);
            }, 30000);
            return;
        }
        // Fallback: derive from the host default data root.
        callHostGuarded("encodeBridge(getDefaultRootPath())", function (rootPath) {
            var root = (rootPath || "").replace(/\\/g, "/").replace(/\/+$/, "");
            DIR = (root || "") + "/text_animations";
            callHostGuarded('taEnsureTextDir("' + encodeBridge(DIR) + '")', function () {
                if (cb) cb(DIR);
            }, 30000);
        }, 30000);
    }

    // ── One-time migration & consolidation (strictly guarded against resurrection) ──
    var MIGRATION_KEY = "ta_text_migrated_v2";
    function migrateOldTextPresets() {
        var fs = nfs(); var r = req();
        if (!fs || !r || !DIR) return;

        // 1. Consolidate any presets previously saved to comp/text_animations
        try {
            var compTextDir = DIR.replace(/\/text_animations$/, "/comp/text_animations");
            if (compTextDir !== DIR && fs.existsSync(compTextDir)) {
                var compEntries = fs.readdirSync(compTextDir);
                for (var ci = 0; ci < compEntries.length; ci++) {
                    var cName = compEntries[ci];
                    var cSrc = compTextDir + "/" + cName;
                    var cDst = DIR + "/" + cName;
                    try {
                        var cSt = fs.statSync(cSrc);
                        if (cSt.isDirectory()) {
                            try { fs.mkdirSync(cDst, { recursive: true }); } catch (e) { }
                            var subEntries = fs.readdirSync(cSrc);
                            for (var si = 0; si < subEntries.length; si++) {
                                var sFrom = cSrc + "/" + subEntries[si];
                                var sTo = cDst + "/" + subEntries[si];
                                if (!fs.existsSync(sTo)) {
                                    try { fs.copyFileSync(sFrom, sTo); } catch (eCopy) { }
                                }
                            }
                        } else if (!fs.existsSync(cDst)) {
                            fs.copyFileSync(cSrc, cDst);
                        }
                    } catch (eEntry) { }
                }
            }
        } catch (eCompMigrate) { }

        // 2. Guard: if already migrated from extension directory, NEVER re-copy!
        try {
            if (localStorage.getItem(MIGRATION_KEY) === "true" || fs.existsSync(DIR + "/.migrated")) {
                try { localStorage.setItem(MIGRATION_KEY, "true"); } catch (e) { }
                return;
            }
        } catch (eGuard) { }

        var extBase = "";
        try { extBase = csInterface.getSystemPath(SystemPath.EXTENSION); } catch (e) { return; }
        if (!extBase) return;
        var oldDir = extBase.replace(/\\/g, "/").replace(/\/+$/, "") + "/presets/user_text";
        try { if (!fs.existsSync(oldDir)) return; } catch (e) { return; }

        function copyRecursive(src, dest) {
            try { fs.mkdirSync(dest, { recursive: true }); } catch (e) { }
            var entries;
            try { entries = fs.readdirSync(src); } catch (e) { return; }
            for (var i = 0; i < entries.length; i++) {
                var sp = src + "/" + entries[i];
                var dp = dest + "/" + entries[i];
                try {
                    var st = fs.statSync(sp);
                    if (st.isDirectory()) { copyRecursive(sp, dp); }
                    else if (!fs.existsSync(dp) && !/\.migrated$/i.test(entries[i])) {
                        fs.copyFileSync(sp, dp);
                    }
                } catch (e) { }
            }
        }

        try {
            copyRecursive(oldDir, DIR);
            try { fs.writeFileSync(DIR + "/.migrated", "migrated"); } catch (e) { }
            try { fs.writeFileSync(oldDir + "/.migrated", "moved to " + DIR); } catch (e) { }
            try { localStorage.setItem(MIGRATION_KEY, "true"); } catch (e) { }
        } catch (e) { }
    }

    // ── Filesystem scan (recursive: category = sub-folder) ────────────
    function scan() {
        var fs = nfs();
        var out = [];
        if (!fs || !DIR) return out;
        var favs = getFavorites();

        function findPreview(dir, baseName) {
            var candidates = [
                baseName + ".preview.apng",
                baseName + ".preview.webp",
                baseName + ".thumb.png"
            ];
            for (var k = 0; k < candidates.length; k++) {
                var full = dir.replace(/\/+$/, "") + "/" + candidates[k];
                try {
                    var pst = fs.statSync(full);
                    if (pst.isFile()) {
                        return { path: full, mtime: pst.mtimeMs || (pst.mtime && pst.mtime.getTime()) || 0 };
                    }
                } catch (eP) { }
            }
            return { path: "", mtime: 0 };
        }

        function walk(dir, category) {
            var entries;
            try { entries = fs.readdirSync(dir); } catch (e) { return; }
            for (var i = 0; i < entries.length; i++) {
                var name = entries[i];
                var full = dir.replace(/\/+$/, "") + "/" + name;
                var st;
                try { st = fs.statSync(full); } catch (e2) { continue; }
                if (st.isDirectory()) {
                    walk(full, name); // sub-folder name becomes the category
                } else if (/\.ffx$/i.test(name)) {
                    var display = name.replace(/\.ffx$/i, "");
                    var prev = findPreview(dir, display);
                    var meta = null;
                    try {
                        var jsonPath = dir.replace(/\/+$/, "") + "/" + display + ".json";
                        if (fs.existsSync(jsonPath)) {
                            meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
                        }
                    } catch (eMeta) { }

                    out.push({
                        file: name,
                        path: full,
                        displayName: (meta && meta.name) ? meta.name : display,
                        category: (meta && meta.category) ? meta.category : (category || "My Presets"),
                        favorite: !!favs[name],
                        previewPath: prev.path,
                        previewMtime: prev.mtime,
                        meta: meta
                    });
                }
            }
        }
        // Root-level files default to "My Presets"
        walk(DIR, "My Presets");

        // Guarantee deduplication by category + displayName
        var deduped = [];
        var seenKeys = {};
        for (var d = 0; d < out.length; d++) {
            var p = out[d];
            var key = (p.category + "::" + p.displayName).toLowerCase();
            if (!seenKeys[key]) {
                seenKeys[key] = true;
                deduped.push(p);
            }
        }
        return deduped;
    }

    // ── Filtering ─────────────────────────────────────────────────────
    function filter(list) {
        var q = searchQuery.toLowerCase();
        var res = [];
        for (var i = 0; i < list.length; i++) {
            var p = list[i];
            if (currentCategory !== "All") {
                if (currentCategory === "★ Fav") {
                    if (!p.favorite) continue;
                } else if (("" + p.category).toLowerCase() !== currentCategory.toLowerCase()) {
                    continue;
                }
            }
            if (q && p.displayName.toLowerCase().indexOf(q) === -1) continue;
            res.push(p);
        }
        return res;
    }

    // ── Rendering ──────────────────────────────────────────────────────
    function render() {
        var grid = document.getElementById("ta-grid");
        if (!grid) return;
        var list = filter(presets);

        grid.classList.toggle("bulk-mode", bulkMode);

        if (!list.length) {
            // Shared empty-state pattern (base.css §2.2): container → icon → title → text.
            grid.innerHTML =
                '<div class="ta-empty-state cs-empty-state">' +
                '<span class="cs-empty-state__icon" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 6V5h14v1"/><path d="M12 5v14"/><path d="M9 19h6"/></svg>' +
                '</span>' +
                '<span class="cs-empty-state__title">No Text Animations</span>' +
                '<small class="cs-empty-state__text">Select a text layer and click Save Current</small></div>';
            return;
        }

        var html = "";
        for (var i = 0; i < list.length; i++) {
            var p = list[i];
            var motion = motionForCategory(p.category);
            var favCls = p.favorite ? " active" : "";
            var selCls = (bulkSelected.indexOf(p.path) !== -1) ? " selected-for-delete" : "";
            // Canvas content: ALWAYS render a static "TEXT" placeholder
            // upfront. The animated APNG src is stashed on the card via
            // data-preview and swapped in lazily on mouseenter, then ripped
            // out on mouseleave. This is critical at 250+ presets:
            // <img src=APNG> autoplays and decodes immediately, so without
            // lazy-loading every card holds a live animation in memory,
            // pegging CPU and crashing AE.
            //
            // CEP gotchas in play here:
            //   1. file:// access requires --allow-file-access in the
            //      manifest. Without it, the <img> silently fails.
            //   2. CEF caches by URL, so after a re-render we MUST bust
            //      the cache with ?v=<mtime> or the new APNG won't load.
            //   3. Windows absolute paths need exactly three slashes after
            //      file: (file:///C:/...). encodeURI handles spaces &
            //      unicode but leaves the colon alone, which is what we want.
            var previewUrlAttr = "";
            var canvasHtml = '<span class="ta-card-text">TEXT</span>';
            if (p.previewPath) {
                var fwd = p.previewPath.replace(/\\/g, "/");
                if (fwd.charAt(0) === "/") fwd = fwd.substring(1);
                var url = "file:///" + encodeURI(fwd) + "?v=" + (p.previewMtime || Date.now());
                previewUrlAttr = ' data-preview="' + escapeAttr(url) + '"';
                if (/\.thumb\.png$/i.test(p.previewPath)) {
                    canvasHtml = '<img class="ta-card-preview" src="' + escapeAttr(url) + '" alt="" draggable="false" onerror="this.style.display=\'none\';" />';
                }
            }
            html +=
                '<div class="ta-card' + selCls + '" data-motion="' + motion + '"' + previewUrlAttr +
                ' data-path="' + escapeAttr(p.path) + '" data-file="' + escapeAttr(p.file) + '"' +
                ' data-name="' + escapeAttr(p.displayName) + '" title="' + escapeAttr(p.displayName) + '">' +
                '<div class="ta-card-check">' +
                '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
                '</div>' +
                '<button type="button" class="ta-card-del" data-ta-act="delete" aria-label="Delete animation" title="Delete animation">' +
                '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
                '</button>' +
                '<button type="button" class="ta-card-rename" data-ta-act="rename" aria-label="Rename animation" title="Rename animation">' +
                '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
                '</button>' +
                '<button type="button" class="ta-card-fav' + favCls + '" data-ta-act="favorite" aria-label="Favorite">' +
                '<svg width="9" height="9" viewBox="0 0 24 24" fill="' + (p.favorite ? "currentColor" : "none") + '" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15 8 22 9 17 14 18 21 12 18 6 21 7 14 2 9 9 8 12 2"/></svg>' +
                '</button>' +
                '<div class="ta-card-canvas">' + canvasHtml + '</div>' +
                '<div class="ta-card-label">' + escapeHTML(p.displayName) + '</div>' +
                '</div>';
        }
        grid.innerHTML = html;
        attachHoverPreviews(grid);
    }

    // ── Lazy APNG hover preview ─────────────────────────────────────────
    // Cards render with a static "TEXT" placeholder. The animated APNG is
    // attached only on mouseenter and torn down on mouseleave so at most
    // ONE preview is decoding at any moment — keeps memory bounded and AE
    // happy at 250+ presets. innerHTML replacement on each render() drops
    // the old DOM nodes (and their listeners) automatically, so we just
    // re-bind every render.
    var hoverActiveCard = null;

    var ALL_GRID_CONTAINER_IDS = [
        "comp-list-container",
        "transition-list-container",
        "text-list-container",
        "footage-list-container",
        "effect-list-container",
        "icon-list-container",
        "ta-grid"
    ];

    function getPreviewCardFromTarget(target, rootEl) {
        var el = target;
        while (el && el !== rootEl && el !== document.body && el !== document.documentElement) {
            if (el.nodeType === 1 && (el.classList.contains("card") || el.classList.contains("ta-card")) && el.hasAttribute("data-preview")) {
                return el;
            }
            el = el.parentNode;
        }
        return null;
    }

    function onGridMouseOver(event) {
        var card = getPreviewCardFromTarget(event.target, this);
        if (!card) return;
        var related = event.relatedTarget;
        if (related && card.contains(related)) return;
        activatePreview(card);
    }

    function onGridMouseOut(event) {
        var card = getPreviewCardFromTarget(event.target, this);
        if (!card) return;
        var related = event.relatedTarget;
        if (related && card.contains(related)) return;
        deactivatePreview(card);
    }

    function bindGridDelegation(grid) {
        if (!grid || grid._csHoverBound) return;
        grid.addEventListener("mouseover", onGridMouseOver);
        grid.addEventListener("mouseout", onGridMouseOut);
        grid._csHoverBound = true;
    }

    function bindAllGridContainers() {
        if (typeof document === "undefined") return;
        for (var i = 0; i < ALL_GRID_CONTAINER_IDS.length; i++) {
            var el = document.getElementById(ALL_GRID_CONTAINER_IDS[i]);
            if (el) bindGridDelegation(el);
        }
    }

    if (typeof window !== "undefined" && window.addEventListener) {
        window.addEventListener("blur", function () {
            if (hoverActiveCard) deactivatePreview(hoverActiveCard);
        });
    }

    function activatePreview(card) {
        if (!card) return;
        var url = card.getAttribute("data-preview");
        if (!url) return;
        var container = card.querySelector(".ta-card-canvas") || card.querySelector(".thumb-box");
        if (!container) return;
        if (hoverActiveCard === card && container.querySelector(".ta-card-preview")) {
            return;
        }
        // Tear down any other active preview first (defensive — mouseleave
        // should already have fired, but quick mouse motion can skip it).
        if (hoverActiveCard && hoverActiveCard !== card) {
            deactivatePreview(hoverActiveCard);
        }
        var cleanUrl = url.split("?")[0];
        var busterUrl = cleanUrl + "?t=" + Date.now();
        container.innerHTML = '<img class="ta-card-preview" src="' + escapeAttr(busterUrl) +
            '" alt="" draggable="false" ' +
            'onerror="this.style.display=\'none\';" />';
        hoverActiveCard = card;
    }
    function deactivatePreview(card) {
        if (!card) return;
        var container = card.querySelector(".ta-card-canvas") || card.querySelector(".thumb-box");
        if (!container) return;
        if (!container.querySelector(".ta-card-preview") && hoverActiveCard !== card) {
            return;
        }
        if (card.classList.contains("ta-card")) {
            var url = card.getAttribute("data-preview");
            if (url && /\.thumb\.png$/i.test(url)) {
                container.innerHTML = '<img class="ta-card-preview" src="' + escapeAttr(url) + '" alt="" draggable="false" onerror="this.style.display=\'none\';" />';
            } else {
                container.innerHTML = '<span class="ta-card-text">TEXT</span>';
            }
        } else {
            var thumbSrc = card.getAttribute("data-thumb");
            if (thumbSrc) {
                container.innerHTML = '<img class="thumb-img" src="' + escapeAttr(thumbSrc) + '" alt="" loading="lazy">';
            } else {
                var isEffect = (card.getAttribute("data-cat") === "effect" || (card.id && card.id.indexOf("effect") !== -1));
                if (isEffect) {
                    container.innerHTML =
                        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"' +
                        ' stroke="rgba(79,140,255,0.4)" stroke-width="1.5" stroke-linejoin="round">' +
                        '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>';
                } else {
                    container.innerHTML =
                        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"' +
                        ' stroke="rgba(168,85,247,0.15)" stroke-width="1.5">' +
                        '<rect x="3" y="3" width="18" height="18" rx="3"/></svg>';
                }
            }
        }
        if (hoverActiveCard === card) hoverActiveCard = null;
    }
    function onCardMouseEnter() { activatePreview(this); }
    function onCardMouseLeave() { deactivatePreview(this); }
    function attachHoverPreviews(grid) {
        if (!grid) return;
        bindGridDelegation(grid);
        bindAllGridContainers();
        var cards = grid.querySelectorAll(".ta-card[data-preview], .card[data-preview]");
        for (var hi = 0; hi < cards.length; hi++) {
            cards[hi].addEventListener("mouseenter", onCardMouseEnter);
            cards[hi].addEventListener("mouseleave", onCardMouseLeave);
        }
        hoverActiveCard = null;
    }

    function refreshFromDisk() {
        presets = scan();
        render();
        renderTextCategorySystem();
        notifyPresetsChanged();
    }

    // ── Preset list for the Workbench Text Preset Browser (Req 12.1) ──
    var presetListeners = [];

    function getPresets() {
        var copy = [];
        for (var i = 0; i < presets.length; i++) {
            copy.push(Object.freeze({
                path: presets[i].path,
                displayName: presets[i].displayName,
                category: presets[i].category,
                favorite: presets[i].favorite
            }));
        }
        return Object.freeze(copy);
    }

    function onPresetsChanged(fn) {
        if (typeof fn !== "function") return function () { };
        presetListeners.push(fn);
        return function () {
            var i = presetListeners.indexOf(fn);
            if (i >= 0) presetListeners.splice(i, 1);
        };
    }

    function notifyPresetsChanged() {
        var list = presetListeners.slice(0);
        for (var i = 0; i < list.length; i++) {
            try { list[i](getPresets()); } catch (e) { /* ignore */ }
        }
    }

    // ── Category dropdown ──────────────────────────────────────────────
    function setCategory(cat) {
        currentCategory = cat;
        render();
        renderTextCategorySystem();
    }

    function renderTextCategorySystem() {
        var badge = document.getElementById("ta-category-badge");
        var listContainer = document.getElementById("ta-dropdown-list");
        if (!listContainer) return;

        listContainer.innerHTML = "";

        var counts = { "All": 0, "★ Fav": 0 };
        var customCats = [];

        for (var i = 0; i < presets.length; i++) {
            var p = presets[i];
            counts["All"]++;
            if (p.favorite) {
                counts["★ Fav"]++;
            }
            var cat = p.category || "My Presets";
            if (!counts[cat]) {
                counts[cat] = 0;
                customCats.push(cat);
            }
            counts[cat]++;
        }

        customCats.sort();

        if (badge) {
            badge.textContent = "+" + customCats.length;
        }

        for (var cIdx = 0; cIdx < customCats.length; cIdx++) {
            (function (cat) {
                var row = document.createElement("div");
                row.className = "category-row" + (currentCategory === cat ? " active" : "");

                var nameSpan = document.createElement("span");
                nameSpan.className = "cat-name";
                nameSpan.textContent = cat;

                var countSpan = document.createElement("span");
                countSpan.className = "cat-count";
                countSpan.textContent = counts[cat] || 0;

                row.appendChild(nameSpan);
                row.appendChild(countSpan);

                row.addEventListener("click", function (e) {
                    e.stopPropagation();
                    setCategory(cat);
                    var dropdown = document.getElementById("ta-dropdown-menu");
                    if (dropdown) dropdown.classList.remove("open");
                });

                listContainer.appendChild(row);
            })(customCats[cIdx]);
        }

        var btnAll = document.getElementById("btn-ta-cat-all");
        var btnFav = document.getElementById("btn-ta-cat-fav");
        if (btnAll) btnAll.className = "category-tab" + (currentCategory === "All" ? " active" : "");
        if (btnFav) btnFav.className = "category-tab" + (currentCategory === "★ Fav" ? " active" : "");
    }

    // ── Atomic Deletion Helpers ─────────────────────────────────────────
    function purgePresetFiles(presetPath) {
        if (!presetPath) return false;
        var fs = nfs();
        var dir = "";
        var baseName = "";
        try {
            var r = req();
            if (r) {
                var nodePath = r("path");
                dir = nodePath.dirname(presetPath);
                baseName = nodePath.basename(presetPath, nodePath.extname(presetPath));
            }
        } catch (eR) { }

        if (!dir || !baseName) {
            var fwd = presetPath.replace(/\\/g, "/");
            var lastSlash = fwd.lastIndexOf("/");
            dir = lastSlash !== -1 ? fwd.substring(0, lastSlash) : "";
            var fileName = lastSlash !== -1 ? fwd.substring(lastSlash + 1) : fwd;
            baseName = fileName.replace(/\.[^.]+$/, "");
        }

        var candidates = [
            presetPath,
            dir + "/" + baseName + ".preview.apng",
            dir + "/" + baseName + ".preview.webp",
            dir + "/" + baseName + ".thumb.png",
            dir + "/" + baseName + ".json"
        ];

        var anyRemoved = false;
        if (fs) {
            for (var c = 0; c < candidates.length; c++) {
                try {
                    if (fs.existsSync(candidates[c])) {
                        fs.unlinkSync(candidates[c]);
                        anyRemoved = true;
                    }
                } catch (eUnlink) { }
            }

            // Also scrub matching files from extension directory (presets/user_text)
            // to permanently prevent resurrection on future launches
            try {
                var extBase = csInterface.getSystemPath(SystemPath.EXTENSION);
                if (extBase) {
                    var oldDir = extBase.replace(/\\/g, "/").replace(/\/+$/, "") + "/presets/user_text";
                    var oldCandidates = [
                        oldDir + "/" + baseName + ".ffx",
                        oldDir + "/" + baseName + ".preview.apng",
                        oldDir + "/" + baseName + ".thumb.png",
                        oldDir + "/My Presets/" + baseName + ".ffx",
                        oldDir + "/My Presets/" + baseName + ".preview.apng"
                    ];
                    for (var oc = 0; oc < oldCandidates.length; oc++) {
                        try {
                            if (fs.existsSync(oldCandidates[oc])) {
                                fs.unlinkSync(oldCandidates[oc]);
                            }
                        } catch (eOld) { }
                    }
                }
            } catch (eExtOld) { }
        }

        // Host ExtendScript fallback deletion (handles locked files / AE project scope)
        try {
            callHostGuarded('taDeleteTextPreset("' + encodeBridge(presetPath) + '")', null, 30000);
        } catch (eHost) { }

        // Clean favorites in localStorage
        try {
            var fileNameOnly = baseName + ".ffx";
            var favs = getFavorites();
            if (favs[fileNameOnly] || favs[presetPath]) {
                delete favs[fileNameOnly];
                delete favs[presetPath];
                localStorage.setItem(FAV_KEY, JSON.stringify(favs));
            }
        } catch (eFav) { }

        // Clean preview seen cache
        try {
            delete previewJobSeen[presetPath];
        } catch (ePrev) { }

        return anyRemoved;
    }

    // ── Bulk delete ────────────────────────────────────────────────────
    function setBulkMode(on) {
        bulkMode = on;
        bulkSelected = [];
        var toggle = document.getElementById("btn-ta-bulk-toggle");
        var countEl = document.getElementById("ta-delete-count");
        var confirm = document.getElementById("ta-bulk-confirm");
        if (toggle) toggle.classList.toggle("active", on);
        if (countEl) { countEl.textContent = "(0)"; countEl.style.display = on ? "inline-block" : "none"; }
        if (confirm) confirm.classList.remove("show");
        render();
    }

    function updateBulkCount() {
        var countEl = document.getElementById("ta-delete-count");
        if (countEl) countEl.textContent = "(" + bulkSelected.length + ")";
    }

    function performBulkDelete() {
        if (!bulkSelected || bulkSelected.length === 0) return;
        if (typeof Settings !== "undefined" && Settings.get && Settings.get("ui.confirmDelete")) {
            if (!confirm("Delete " + bulkSelected.length + " selected text animation(s)?")) return;
        }

        var count = 0;
        for (var i = 0; i < bulkSelected.length; i++) {
            purgePresetFiles(bulkSelected[i]);
            count++;
        }

        bulkSelected = [];
        setBulkMode(false);
        showToast("Deleted " + count + " text animation" + (count === 1 ? "" : "s"), "success");
        refreshFromDisk();
    }

    function deleteOne(path) {
        if (!path) return;
        var nameToDisplay = "";
        for (var pIdx = 0; pIdx < presets.length; pIdx++) {
            if (presets[pIdx].path === path) {
                nameToDisplay = presets[pIdx].displayName;
                break;
            }
        }
        if (!nameToDisplay) {
            var match = path.match(/([^\\\/]+)\.ffx$/i);
            nameToDisplay = match ? match[1] : "this animation";
        }

        if (typeof Settings !== "undefined" && Settings.get && Settings.get("ui.confirmDelete")) {
            if (!confirm('Delete "' + nameToDisplay + '"?')) return;
        }

        purgePresetFiles(path);

        // Optimistic removal from in-memory presets array
        var remaining = [];
        for (var i = 0; i < presets.length; i++) {
            if (presets[i].path !== path) remaining.push(presets[i]);
        }
        presets = remaining;

        var bIdx = bulkSelected.indexOf(path);
        if (bIdx > -1) {
            bulkSelected.splice(bIdx, 1);
            updateBulkCount();
        }

        showToast('Deleted "' + nameToDisplay + '"', "success");
        render();
        renderTextCategorySystem();
        refreshFromDisk();
    }

    function resetTextLayers() {
        callHostGuarded('taResetSelectedTextLayers()', function (resultStr, err) {
            if (err || !resultStr) {
                showToast("AE not responding", "error");
                return;
            }
            try {
                var res = JSON.parse(resultStr);
                if (!res) return;
                if (res.ok) {
                    if (res.resetCount > 0) {
                        showToast("Successfully reset " + res.resetCount + " text layer(s)", "success");
                    } else if (res.skippedCount > 0) {
                        showToast("Selected layer is not a text layer", "error");
                    } else {
                        showToast("No layers were reset", "info");
                    }
                } else {
                    showToast(res.error || "Reset failed", "error");
                }
            } catch (e) {
                showToast("Failed to parse reset response", "error");
            }
        }, 30000);
    }

    // ── Rename preset (.ffx + preview siblings) ─────────────────────────
    var pendingRenamePath = "";
    function openRenameModal(path, currentName) {
        pendingRenamePath = path || "";
        var modal = document.getElementById("ta-preset-rename-modal");
        var input = document.getElementById("ta-preset-rename-input");
        if (input) {
            input.value = currentName || "";
            setTimeout(function () { input.focus(); try { input.select(); } catch (e) { } }, 30);
        }
        if (modal) {
            modal.classList.add("open");
            FocusTrap.activate(modal);
        }
    }

    function confirmRename() {
        var input = document.getElementById("ta-preset-rename-input");
        var newName = input ? input.value.replace(/^\s+|\s+$/g, "") : "";
        if (!newName) { showToast("Enter a name", "error"); return; }
        if (!pendingRenamePath) { showToast("Nothing to rename", "error"); return; }

        var fs = nfs(); var r = req();
        if (!fs || !r) { showToast("Filesystem unavailable", "error"); return; }
        var nodePath = r("path");

        var safeName = newName.replace(/[\\\/:\*\?"<>\|]/g, "_");
        var dir = nodePath.dirname(pendingRenamePath);
        var oldBase = nodePath.basename(pendingRenamePath).replace(/\.ffx$/i, "");
        if (safeName === oldBase) {
            FocusTrap.deactivate();
            var m0 = document.getElementById("ta-preset-rename-modal");
            if (m0) m0.classList.remove("open");
            return;
        }

        var newFfx = dir + "/" + safeName + ".ffx";
        if (fs.existsSync(newFfx)) { showToast("A preset with that name exists", "error"); return; }

        // Rename the .ffx plus any sibling preview/thumb/json files in lock-step.
        var suffixes = [".ffx", ".preview.apng", ".preview.webp", ".thumb.png", ".json"];
        var renamedMain = false;
        for (var i = 0; i < suffixes.length; i++) {
            var from = dir + "/" + oldBase + suffixes[i];
            var to = dir + "/" + safeName + suffixes[i];
            try {
                if (fs.existsSync(from)) {
                    fs.renameSync(from, to);
                    if (i === 0) renamedMain = true;
                    if (suffixes[i] === ".json") {
                        try {
                            var metaObj = JSON.parse(fs.readFileSync(to, "utf8"));
                            metaObj.name = newName;
                            metaObj.updatedAt = new Date().toISOString();
                            fs.writeFileSync(to, JSON.stringify(metaObj, null, 2), "utf8");
                        } catch (eMeta) { }
                    }
                }
            } catch (e) { if (i === 0) { showToast("Rename failed", "error"); return; } }
        }

        // Move the favorite flag to the new filename.
        try {
            var favs = getFavorites();
            if (favs[oldBase + ".ffx"]) {
                delete favs[oldBase + ".ffx"];
                favs[safeName + ".ffx"] = true;
                localStorage.setItem(FAV_KEY, JSON.stringify(favs));
            }
        } catch (eF) { }

        var modal = document.getElementById("ta-preset-rename-modal");
        FocusTrap.deactivate();
        if (modal) modal.classList.remove("open");
        pendingRenamePath = "";
        if (renamedMain) showToast('Renamed to "' + escapeHTML(newName) + '"', "success");
        refreshFromDisk();
    }

    // ── Apply preset (single click) ─────────────────────────────────────
    function applyPreset(path) {
        callHostGuarded('taApplyTextPreset("' + encodeBridge(path) + '")', function (resStr, err) {
            if (err || !resStr) {
                showToast("AE not responding", "error"); return;
            }
            var res = {};
            try { res = JSON.parse(resStr); } catch (e) { res = { ok: false, error: resStr }; }
            if (!res.ok) { showToast(res.error || "Apply failed", "error"); return; }
            showToast(res.created ? "New text layer created + animated" : "Text animation applied", "success");
        }, 30000);
    }

    // ── Save current ────────────────────────────────────────────────────
    function openSaveModal() {
        var modal = document.getElementById("ta-save-modal");
        var nameInput = document.getElementById("ta-name-input");
        if (nameInput) nameInput.value = "";
        populateModalCategories();
        if (modal) {
            modal.classList.add("open");
            FocusTrap.activate(modal);
        }

        // Smart auto-name: ask the host to inspect the selected text layer
        // and propose a friendly name based on its animators/effects.
        // Async — we open the modal immediately and fill the input when AE
        // responds (usually <50ms). User can overtype as soon as it lands.
        if (nameInput) {
            try {
                callHostGuarded("taDetectAnimationName()", function (resStr, err) {
                    if (err || !resStr) return;
                    var res = {};
                    try { res = JSON.parse(resStr); }
                    catch (eP) { res = {}; }
                    // Only inject if the user hasn't already started typing.
                    if (!nameInput.value && res && res.name) {
                        nameInput.value = res.name;
                        try { nameInput.select(); } catch (eSel) { }
                    }
                }, 10000);
            } catch (eEv) { }
        }

        if (nameInput) setTimeout(function () { nameInput.focus(); }, 30);
    }

    function populateModalCategories() {
        var dd = document.getElementById("ta-modal-cat-dropdown");
        var valEl = document.getElementById("ta-modal-cat-value");
        if (!dd) return;
        pendingSaveCat = "My Presets";
        if (valEl) valEl.textContent = pendingSaveCat;
        var cats = ["My Presets", "Flicker", "Fade In", "Bounce"];
        dd.innerHTML = "";
        for (var i = 0; i < cats.length; i++) {
            var b = document.createElement("div");
            b.className = "custom-select-option" + (cats[i] === pendingSaveCat ? " active" : "");
            b.textContent = cats[i];
            b.dataset.cat = cats[i];
            dd.appendChild(b);
        }
    }

    // Snapshot the set of .ffx files under one or more roots, recursively,
    // mapped to mtime. We watch a wide net of AE-related folders because
    // the native Save dialog can land the file under any of several
    // version- and locale-specific paths (and OneDrive redirection moves
    // them again).
    function snapshotFfxDir(roots) {
        var fs = nfs();
        var map = {};
        if (!fs) return map;
        var list = (typeof roots === "string") ? [roots] : (roots || []);
        var MAX_DEPTH = 6;
        function walk(dir, depth) {
            if (!dir || depth > MAX_DEPTH) return;
            var entries;
            try { entries = fs.readdirSync(dir); } catch (e) { return; }
            for (var i = 0; i < entries.length; i++) {
                var name = entries[i];
                var full = dir.replace(/\/+$/, "") + "/" + name;
                var st;
                try { st = fs.statSync(full); } catch (e2) { continue; }
                if (st.isDirectory()) {
                    walk(full, depth + 1);
                } else if (/\.ffx$/i.test(name)) {
                    map[full] = st.mtimeMs || (st.mtime && st.mtime.getTime()) || 0;
                }
            }
        }
        for (var r = 0; r < list.length; r++) walk(list[r], 0);
        return map;
    }

    // Diff two snapshots. Returns the path of the most recently written
    // file present in `after` but not in `before`, or whose mtime advanced.
    function diffFfxSnapshots(before, after) {
        var newest = null;
        var newestTime = 0;
        for (var path in after) {
            if (!Object.prototype.hasOwnProperty.call(after, path)) continue;
            var t = after[path];
            var prev = before[path];
            if (prev === undefined || (t && t > prev)) {
                if (t >= newestTime) { newest = path; newestTime = t; }
            }
        }
        return newest;
    }

    // Save Animation Preset flow.
    //
    // AE has no scripting API to write a .ffx silently from selected
    // properties. The only real path is executeCommand("Save Animation
    // Preset…"), which opens AE's native save dialog targeting the User
    // Presets folder. Workflow:
    //   1. Validate selection is a single Text Layer.
    //   2. Resolve AE's User Presets dir; snapshot its .ffx contents.
    //   3. Invoke the native dialog. User confirms or cancels.
    //   4. Re-snapshot; diff to find the new .ffx.
    //   5. Relocate it into the CompSaver library under the chosen category,
    //      renamed to the user's chosen display name.
    function confirmSave() {
        var nameInput = document.getElementById("ta-name-input");
        var name = nameInput ? nameInput.value.replace(/^\s+|\s+$/g, "") : "";
        if (!name) { showToast("Enter an animation name", "error"); return; }

        var confirmBtn = document.getElementById("btn-ta-save-confirm");
        if (confirmBtn) confirmBtn.disabled = true;

        // Step 1 — validate selection before doing anything else.
        callHostGuarded("taValidateTextSelection()", function (vStr, err) {
            if (err || !vStr) {
                if (confirmBtn) confirmBtn.disabled = false;
                showToast("AE not responding", "error"); return;
            }
            var vRes = {};
            try { vRes = JSON.parse(vStr); }
            catch (e) { vRes = { ok: false, error: vStr }; }
            if (!vRes.ok) {
                if (confirmBtn) confirmBtn.disabled = false;
                showToast(vRes.error || "Selection invalid", "error"); return;
            }

            // Close the modal
            FocusTrap.deactivate();
            var modal = document.getElementById("ta-save-modal");
            if (modal) modal.classList.remove("open");

            // Step 2 — Save preset (try direct first, fallback to native dialog)
            resolveDir(function (dir) {
                var safeName = name.replace(/[\\\/:\*\?"<>\|]/g, "_");
                var category = pendingSaveCat || "My Presets";
                var destDir = dir.replace(/\/+$/, "") + "/" + category;
                var destPath = destDir + "/" + safeName + ".ffx";

                var fs = nfs();
                if (fs) { try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) { } }

                function finalizeSavedPreset(actualSavedPath) {
                    if (confirmBtn) confirmBtn.disabled = false;

                    // Verify on-disk persistence — no ghost UI cards!
                    if (fs && !fs.existsSync(actualSavedPath)) {
                        showToast("Save failed: Preset was not written to disk", "error");
                        return;
                    }

                    // Write companion metadata .json
                    if (fs) {
                        try {
                            var metaObj = {
                                id: "ta_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6),
                                name: name,
                                category: category,
                                createdAt: new Date().toISOString(),
                                updatedAt: new Date().toISOString(),
                                version: 1
                            };
                            var metaPath = actualSavedPath.replace(/\.ffx$/i, ".json");
                            fs.writeFileSync(metaPath, JSON.stringify(metaObj, null, 2), "utf8");
                        } catch (eM) {
                            try { console.warn("[CompSaver] Failed to write preset metadata:", eM); } catch (eL) { }
                        }
                    }

                    // Fire-and-forget preview render.
                    showToast("Saving & generating preview...", "info");
                    enqueuePreviewRender(actualSavedPath, name, function (err) {
                        if (err) {
                            try { console.log("[CompSaver] preview failed:", err); } catch (eL) { }
                            showToast("Saved, but preview failed", "error");
                        } else {
                            showToast('Saved "' + escapeHTML(name) + '" (Preview Ready)', "success");
                        }
                        refreshFromDisk();
                    }, true);
                }

                function fallbackNativeDialog() {
                    callHostGuarded("taResolveUserPresetsDir()", function (rStr, rErr) {
                        var roots = [];
                        if (!rErr && rStr) {
                            try {
                                var rRes = JSON.parse(rStr);
                                if (rRes.ok && rRes.paths) {
                                    roots = rRes.paths.split("|").filter(function (s) { return !!s; });
                                }
                            } catch (eR) { }
                        }

                        var beforeSnap = snapshotFfxDir(roots);
                        var watchRoot = roots[0] || "";
                        var dlgJsx = 'taInvokeSavePresetDialog("' + encodeBridge(watchRoot) + '")';

                        callHostGuarded(dlgJsx, function (dStr, dErr) {
                            if (dErr || !dStr) {
                                if (confirmBtn) confirmBtn.disabled = false;
                                showToast("Save dialog failed", "error");
                                return;
                            }
                            var dRes = {};
                            try { dRes = JSON.parse(dStr); }
                            catch (e) { dRes = { ok: false, error: dStr }; }

                            if (!dRes.ok) {
                                if (confirmBtn) confirmBtn.disabled = false;
                                showToast(dRes.error || "Save cancelled or failed", "error");
                                return;
                            }

                            var afterSnap = snapshotFfxDir(roots);
                            var newFfx = diffFfxSnapshots(beforeSnap, afterSnap);
                            if (!newFfx) {
                                if (confirmBtn) confirmBtn.disabled = false;
                                showToast("Save cancelled", "info");
                                return;
                            }

                            // Relocate preset to our CompSaver library directory
                            var relJsx = 'taRelocatePreset("' + encodeBridge(newFfx) + '", "' +
                                encodeBridge(destDir) + '", "' + encodeBridge(safeName) + '")';
                            callHostGuarded(relJsx, function (mStr, mErr) {
                                var mRes = {};
                                try { mRes = JSON.parse(mStr || ""); }
                                catch (eM) { mRes = { ok: false }; }

                                var finalPath = (mRes.ok && mRes.path) ? mRes.path : destPath;
                                finalizeSavedPreset(finalPath);
                            }, 30000);
                        }, 60000);
                    }, 30000);
                }

                // Try direct save first
                var jsx = 'taSavePresetDirectly("' + encodeBridge(destPath) + '")';
                callHostGuarded(jsx, function (sStr, sErr) {
                    var sRes = {};
                    try { sRes = JSON.parse(sStr || ""); }
                    catch (e) { sRes = { ok: false, error: sStr || "" }; }

                    if (!sErr && sRes.ok && sRes.path) {
                        finalizeSavedPreset(sRes.path);
                    } else {
                        // Fallback to native dialog if direct save is unsupported
                        fallbackNativeDialog();
                    }
                }, 30000);
            });
        });
    }

    // ── Import external .ffx ─────────────────────────────────────────────
    function importFiles() {
        resolveDir(function (dir) {
            callHostGuarded("encodeBridge(taPickFfxFiles())", function (raw, err) {
                if (err || !raw) { return; }
                var paths = raw.split("|").filter(function (s) { return !!s; });
                if (!paths.length) return;
                var fs = nfs(); var r = req();
                if (!fs || !r) { showToast("Filesystem unavailable", "error"); return; }
                var nodePath = r("path");
                var dest = dir;
                if (currentCategory !== "All" && currentCategory !== "My Presets") {
                    dest = dir.replace(/\/+$/, "") + "/" + currentCategory;
                    try { fs.mkdirSync(dest, { recursive: true }); } catch (e) { }
                }
                var count = 0;
                var copiedPaths = [];
                for (var i = 0; i < paths.length; i++) {
                    try {
                        var fname = nodePath.basename(paths[i]);
                        if (!/\.ffx$/i.test(fname)) continue;
                        var copiedTo = dest.replace(/\/+$/, "") + "/" + fname;
                        fs.copyFileSync(paths[i], copiedTo);
                        copiedPaths.push({ path: copiedTo, label: fname.replace(/\.ffx$/i, "") });
                        count++;
                    } catch (e2) { }
                }
                showToast("Imported " + count + " file" + (count === 1 ? "" : "s"), "success");
                refreshFromDisk();
                // Render a preview for each newly-imported preset. Single-flight
                // queue serializes the AE renders so they don't pile up.
                for (var ci = 0; ci < copiedPaths.length; ci++) {
                    enqueuePreviewRender(copiedPaths[ci].path, copiedPaths[ci].label, null);
                }
            });
        });
    }

    // Manual backfill: regenerate previews for every preset currently in
    // view. Used when a user wants to re-render previews for imported or
    // pre-existing .ffx files. Bypasses the on-disk dedup so previews
    // that already exist still get regenerated.
    function backfillPreviewsForCurrentView() {
        var list = filter(presets);
        if (!list.length) { showToast("No presets to render", "info"); return; }
        // Reset dedup for these paths so they're not skipped.
        for (var i = 0; i < list.length; i++) {
            delete previewJobSeen[list[i].path];
        }
        showToast("Rendering " + list.length + " preview" + (list.length === 1 ? "" : "s") + "…", "info");
        for (var j = 0; j < list.length; j++) {
            enqueuePreviewRender(list[j].path, list[j].displayName, null);
        }
    }

    // ── Preview render pipeline ──────────────────────────────────────────
    //
    // AE renders the preset against a hidden 320x90 comp → PNG sequence in
    // a temp folder → ffmpeg encodes APNG → sibling file Foo.preview.apng
    // next to the .ffx → next render() picks it up via findPreview().
    //
    // Runs entirely in the background after Save Current. The card appears
    // immediately with a placeholder; APNG swaps in 5-8s later. Single-flight
    // queue (`previewQueue`) prevents concurrent AE renders from thrashing.

    var previewQueue = [];
    var previewRunning = false;
    // The queue job currently dispatched to a runner (preview or thumbnail),
    // or null between jobs. Tracked so a scheduler-side ae-lane timeout can
    // fail the held job and advance the queue (M3).
    var previewCurrentJob = null;
    var ffmpegPathCache = null; // null=untried, ""=none found, "..."=resolved

    function getNodePath() {
        var r = req();
        return r ? r("path") : null;
    }
    function getChildProcess() {
        var r = req();
        try { return r ? r("child_process") : null; } catch (e) { return null; }
    }
    function getOS() {
        var r = req();
        try { return r ? r("os") : null; } catch (e) { return null; }
    }

    // resolveFfmpeg is now a global utility in utils.js

    // Create the per-render temp directory under the OS temp root.
    function makePreviewTempDir() {
        var os = getOS();
        var nodePath = getNodePath();
        var fs = nfs();
        if (!os || !nodePath || !fs) return "";
        var base = os.tmpdir().replace(/\\/g, "/");
        var dir = base + "/compsaver_preview_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return ""; }
        return dir;
    }

    function rmTempDir(dir) {
        var fs = nfs(); if (!fs || !dir) return;
        try {
            var entries = fs.readdirSync(dir);
            for (var i = 0; i < entries.length; i++) {
                try { fs.unlinkSync(dir.replace(/\/+$/, "") + "/" + entries[i]); } catch (e) { }
            }
            try { fs.rmdirSync(dir); } catch (e2) { }
        } catch (e3) { }
    }

    // Spawn ffmpeg to encode input -> APNG.
    //
    // Two input modes:
    //   isSequence=true  → PNG sequence (preferred, headless renderer).
    //                      -framerate MUST precede -i for sequence input;
    //                      inputFilename is a printf pattern (e.g.
    //                      "preview_%05d.png").
    //   isSequence=false → Single video file (legacy RQ path, kept for
    //                      back-compat in case any older render result
    //                      lands in temp dir).
    // APNG flags: -plays 0 (loop forever), -f apng for explicit format.
    // Max frames an APNG is allowed to contain (~4s at 30fps). Longer
    // animations are resampled DOWN to this so the hover preview plays in
    // ~4s (sped up) while still showing the ENTIRE animation — and the file
    // stays small.
    var APNG_MAX_FRAMES = 120;
    var APNG_TARGET_SECONDS = 4.0;

    function encodeApng(ffmpeg, tempDir, inputFilename, frameRate, outApng, isSequence, startNumber, frameCount, cb) {
        // Back-compat for older call shapes:
        //   (…, isSequence, cb)                  → cb in arg 7
        //   (…, isSequence, startNumber, cb)     → cb in arg 8
        if (typeof startNumber === "function" && typeof cb === "undefined") {
            cb = startNumber; startNumber = 0; frameCount = 0;
        } else if (typeof frameCount === "function" && typeof cb === "undefined") {
            cb = frameCount; frameCount = 0;
        }
        if (typeof startNumber !== "number") startNumber = 0;
        if (typeof frameCount !== "number") frameCount = 0;

        var cp = getChildProcess();
        if (!cp) { cb("child_process unavailable"); return; }
        var nodePath = getNodePath();
        var input = nodePath ? nodePath.join(tempDir, inputFilename) : (tempDir + "/" + inputFilename);

        var args;
        if (isSequence) {
            // STEP 4 — playback compression. If the real frame count F on
            // disk exceeds APNG_MAX_FRAMES, read the sequence at a HIGHER
            // input framerate (F / APNG_TARGET_SECONDS) so the whole thing
            // plays in ~4s, then resample to a normal output fps. ffmpeg's
            // fps filter picks frames evenly across the full range, so the
            // entire animation is shown — just sped up. Otherwise read at
            // real speed (frameRate) with no filter.
            var readRate = frameRate;
            var outFilter = null;
            if (frameCount > APNG_MAX_FRAMES) {
                readRate = frameCount / APNG_TARGET_SECONDS;
                outFilter = "fps=" + frameRate;
            }
            // -start_number MUST precede -i for the image2 demuxer to pick
            // it up. Default ffmpeg behaviour is start_number=1, but our
            // renderer writes 0-based names — without this flag ffmpeg
            // skips frame 0 and then errors on the missing "next" frame.
            args = ["-y", "-framerate", String(readRate),
                "-start_number", String(startNumber),
                "-i", input];
            if (outFilter) args.push("-vf", outFilter);
            args.push("-plays", "0", "-f", "apng", outApng);
        } else {
            args = [
                "-y",
                "-i", input,
                "-vf", "fps=" + frameRate,
                "-plays", "0",
                "-f", "apng",
                outApng
            ];
        }

        try {
            cp.execFile(ffmpeg, args, { timeout: 30000 }, function (err, stdout, stderr) {
                if (err) { cb("ffmpeg: " + (err.message || stderr || "unknown")); return; }
                var fs = nfs();
                var ok = false;
                if (fs) { try { ok = fs.statSync(outApng).isFile(); } catch (eF) { ok = false; } }
                cb(ok ? null : "ffmpeg ran but no output file");
            });
        } catch (eEx) {
            cb("ffmpeg spawn failed: " + (eEx.message || eEx));
        }
    }

    // Track in-flight + completed jobs across this session so we never
    // double-queue the same preset. Cleared only on full reload.
    var previewJobSeen = {};

    // Path of the would-be .preview.apng for a given .ffx or .aep path.
    function previewApngPathFor(presetPath) {
        presetPath = presetPath.replace(/\\/g, "/");
        if (/\.aep$/i.test(presetPath)) {
            return presetPath.replace(/\/(project|preview)\.aep$/i, "") + "/preview.apng";
        }
        return presetPath.replace(/\.ffx$/i, "") + ".preview.apng";
    }

    // Main entry point. Queues a preset for preview rendering. Safe to call
    // many times in a row — only one render runs at a time. Idempotent:
    // skips if an apng already exists or this preset is already queued/running.
    //
    //   presetPath  - absolute path to the .ffx
    //   displayName - text to show in the sample comp (typically preset name)
    //   onDone      - optional cb(err) when this specific render completes
    function enqueuePreviewRender(presetPath, displayName, onDone, force) {
        if (!presetPath) { if (onDone) onDone("no path"); return; }
        if (!force) {
            // Dedup #1: already attempted this session?
            if (previewJobSeen[presetPath]) {
                if (onDone) onDone(null);
                return;
            }
            // Dedup #2: apng already on disk from a previous session?
            var fs = nfs();
            if (fs) {
                try {
                    if (fs.statSync(previewApngPathFor(presetPath)).isFile()) {
                        previewJobSeen[presetPath] = true;
                        if (onDone) onDone(null);
                        return;
                    }
                } catch (eS) { }
            }
        } else {
            var fs = nfs();
            if (fs) {
                try {
                    var apngPath = previewApngPathFor(presetPath);
                    if (fs.existsSync(apngPath)) {
                        fs.unlinkSync(apngPath);
                        console.log("[CompSaver] Deleted existing preview for force-render:", apngPath);
                    }
                } catch (eDel) {
                    console.warn("[CompSaver] Failed to delete existing preview:", eDel);
                }
            }
            previewJobSeen[presetPath] = true;
        }
        previewQueue.push({ path: presetPath, label: displayName || "TEXT", cb: onDone });
        if (!previewRunning) drainPreviewQueue();
    }

    // True only when at least one preview render has actually completed
    // during this session. When false and an error occurs, surface it
    // as a toast — usually it's a misconfiguration (missing ffmpeg, missing
    // PNG Sequence template, etc.) and the user should see it once.
    var previewSucceededOnce = false;
    var previewToastShown = false;

    // Max attempts per preset. Batch imports (10-12 at once) can make a
    // single render fail transiently — AE momentarily busy, temp-folder
    // contention, etc. A short retry rescues those without user action.
    var PREVIEW_MAX_ATTEMPTS = 3;
    var PREVIEW_RETRY_DELAY_MS = 600;

    // Background_Queue budget + retry policy (Req 4.4, 3.4). Every job on the
    // shared serialized queue — preview OR thumbnail — is bounded by the same
    // 60-second per-job budget: if a job throws or does not report back within
    // JOB_BUDGET_MS it is marked failed and the runner advances to the next
    // queued job well within the 1-second bound (Req 4.4). Thumbnail jobs retry
    // up to THUMBNAIL_MAX_ATTEMPTS (3) times before their terminal failure
    // state is patched onto the single affected card (Req 3.4). Jobs render
    // from the saved template `project.aep` (job.aepPath) or a saved preset and
    // never touch the user's live project (Req 4.3).
    var JOB_BUDGET_MS = 60000;
    var THUMBNAIL_TIMEOUT_MS = JOB_BUDGET_MS; // retained alias for readability
    var THUMBNAIL_MAX_ATTEMPTS = 3;

    // Aggregate ae-lane hold budget (M3). One job can legitimately consume
    // PREVIEW_MAX_ATTEMPTS x JOB_BUDGET_MS (3 x 60s); the lane hold spans the
    // WHOLE previewQueue drain, so without a cap a backlog of failing presets
    // could hostage the ae lane for N x ~3 minutes. This bound releases the
    // lane after one full job cycle and fails whatever is still held.
    var AE_LANE_TIMEOUT_MS = PREVIEW_MAX_ATTEMPTS * JOB_BUDGET_MS; // 180000

    // The scheduler can kill the ae-lane hold (lane timeout or dispose); the
    // hold's job promise then resolves with { cancelled: true, reason }. Drop
    // the stale ownership flags, fail the currently held job with a clear
    // reason, and advance the queue so a hostage backlog cannot stall the
    // runner. Only a timeout breach resumes the drain — on dispose the queue
    // is torn down by the onDispose handler instead.
    function abandonLaneHold(reason) {
        drainPreviewQueue._laneOwned = false;
        drainPreviewQueue._laneRelease = null;
        var dead = previewCurrentJob;
        previewCurrentJob = null;
        if (dead) {
            // Mark abandoned so a late callback from the (unkillable) evalScript
            // cannot double-fire cb or advance the queue a second time.
            dead.abandoned = true;
            if (dead.type === "thumbnail") { try { patchThumbnailCardFailed(dead); } catch (eP) { } }
            if (dead.cb) {
                try { dead.cb("ae lane hold lost: " + (reason || "cancelled")); } catch (eCb) { }
            }
            try {
                console.warn("[CompSaver preview] ae lane hold lost (" + (reason || "cancelled") +
                    ") — failing held job: " + (dead.path || dead.aepPath || "?"));
            } catch (eL) { }
        }
        if (/timeout/.test(reason || "") && previewQueue.length) drainPreviewQueue();
        else if (!previewQueue.length) previewRunning = false;
    }

    // Generalized single serialized FIFO job runner (Background_Queue).
    // Invariant: at most one job runs at a time (guarded by `previewRunning`),
    // and jobs start strictly in first-in-first-out order (Req 4.2). Each job's
    // terminal outcome patches exactly one card via a single-card helper —
    // never a full Library_Scan (Req 4.5, 4.6).
    function drainPreviewQueue() {
        if (!previewQueue.length) {
            previewRunning = false;
            if (drainPreviewQueue._laneRelease) {
                var release = drainPreviewQueue._laneRelease;
                drainPreviewQueue._laneRelease = null;
                drainPreviewQueue._laneOwned = false;
                release();
            }
            return;
        }
        var lifecycleMode = typeof FeatureFlags !== "undefined" && FeatureFlags.flags.lifecycleV1 &&
            typeof Scheduler !== "undefined";
        if (lifecycleMode && !drainPreviewQueue._laneOwned) {
            previewRunning = true;
            var laneHandle = Scheduler.enqueue("ae", function () {
                return new Promise(function (resolve) {
                    drainPreviewQueue._laneOwned = true;
                    drainPreviewQueue._laneRelease = resolve;
                    drainPreviewQueue();
                });
            }, { timeoutMs: AE_LANE_TIMEOUT_MS });
            // If the scheduler force-releases the hold (lane timeout breach or
            // dispose), the promise settles with { cancelled: true, reason } —
            // resync local state and advance past the held job (M3).
            laneHandle.promise.then(function (result) {
                if (result && result.cancelled) abandonLaneHold(result.reason);
            });
            return;
        }
        previewRunning = true;
        var job = previewQueue.shift();
        previewCurrentJob = job;
        if (typeof job.attempt !== "number") job.attempt = 1;
        // Dispatch by job kind. Preview jobs have no `type` (back-compat), so
        // only an explicit "thumbnail" is routed to the thumbnail runner. A
        // synchronous throw from either runner is caught here, marked failed,
        // and the queue advances so one bad job never stalls the runner (Req 4.4).
        if (job.type === "thumbnail") {
            try { drainThumbnailJob(job); }
            catch (eThrow) {
                if (previewCurrentJob === job) previewCurrentJob = null;
                try { console.warn("[CompSaver thumbnail] job threw:", eThrow); } catch (eL) { }
                patchThumbnailCardFailed(job);
                if (job.cb) { try { job.cb("job threw: " + (eThrow && eThrow.message ? eThrow.message : eThrow)); } catch (eCb) { } }
                setTimeout(function () { drainPreviewQueue(); }, 0);
            }
            return;
        }
        try {
            runOnePreview(job, function (err) {
                if (previewCurrentJob === job) previewCurrentJob = null;
                // Abandoned by an ae-lane timeout — abandonLaneHold already
                // failed this job and advanced the queue; a late AE/ffmpeg
                // callback must not act a second time.
                if (job.abandoned) return;
                if (err && job.attempt < PREVIEW_MAX_ATTEMPTS) {
                    // Transient failure — requeue the SAME job at the BACK so
                    // the next queued job runs first (FIFO, Req 4.2) and this
                    // one retries later after a short backoff. The next job is
                    // started well within the 1-second bound (Req 4.4).
                    job.attempt++;
                    try {
                        console.log("[CompSaver preview]", job.path,
                            "— retry " + job.attempt + "/" + PREVIEW_MAX_ATTEMPTS +
                            " after error: " + String(err).replace(/\s+/g, " ").slice(0, 120));
                    } catch (eL) { }
                    previewQueue.push(job);
                    setTimeout(function () { drainPreviewQueue(); }, PREVIEW_RETRY_DELAY_MS);
                    return;
                }
                if (job.cb) { try { job.cb(err); } catch (eCb) { } }
                if (err) {
                    // Exhausted retries — this preset will keep its CSS
                    // placeholder. Log the definitive reason per preset so the
                    // failure is never silent.
                    try {
                        console.warn("[CompSaver preview]", job.path,
                            "— FALLBACK (CSS placeholder) after " + job.attempt +
                            " attempt(s): " + err);
                    } catch (eW) { }
                    // Surface the first failure of the session as a toast so
                    // the user knows something's wrong. Subsequent failures
                    // go only to console to avoid spamming.
                    if (!previewToastShown) {
                        previewToastShown = true;
                        var short = String(err).replace(/\s+/g, " ").slice(0, 80);
                        showToast("Preview render failed: " + short, "error");
                    }
                } else {
                    previewSucceededOnce = true;
                    // Patch ONLY the affected card, never a full Library_Scan
                    // (Req 4.5). For an .aep template preview we swap the single
                    // card's preview in place; for an isolated text preset
                    // (.ffx) we re-render the local text grid (that grid is not
                    // the Library_Index, so this is not a Library_Scan).
                    if (/\.aep$/i.test("" + job.path)) {
                        try { refreshCardPreview(job.path); } catch (eR) { }
                    } else {
                        try { refreshFromDisk(); } catch (eR2) { }
                    }
                }
                drainPreviewQueue();
            });
        } catch (eThrowP) {
            // Synchronous throw from the preview runner — mark failed and
            // advance the queue within the 1-second bound (Req 4.4). The
            // preset keeps its placeholder; the live project is untouched.
            if (previewCurrentJob === job) previewCurrentJob = null;
            try { console.warn("[CompSaver preview] job threw:", eThrowP); } catch (eL) { }
            if (job.cb) { try { job.cb("job threw: " + (eThrowP && eThrowP.message ? eThrowP.message : eThrowP)); } catch (eCb) { } }
            setTimeout(function () { drainPreviewQueue(); }, 0);
        }
    }

    // Run a single queued thumbnail job. On failure/timeout the job is
    // abandoned and, if it still has a retry left, requeued at the BACK of the
    // queue so the next queued job runs first (Req 4.2) and retries later, up
    // to THUMBNAIL_MAX_ATTEMPTS (3) attempts (Req 3.4). On the terminal outcome
    // it patches exactly one card — a thumbnail swap on success or a failure
    // state on exhausted retries — never a full Library_Scan (Req 4.5, 4.6).
    // `onDone(err)` fires only on the terminal outcome, never on a retry.
    function drainThumbnailJob(job) {
        if (typeof job.attempt !== "number") job.attempt = 1;
        runOneThumbnail(job, function (err) {
            if (previewCurrentJob === job) previewCurrentJob = null;
            // Abandoned by an ae-lane timeout — abandonLaneHold already failed
            // this job (and patched its card); ignore the late callback.
            if (job.abandoned) return;
            if (err) {
                try {
                    console.warn("[CompSaver thumbnail]", job.aepPath,
                        "— attempt " + job.attempt + "/" + THUMBNAIL_MAX_ATTEMPTS +
                        " failed: " + String(err).replace(/\s+/g, " ").slice(0, 120));
                } catch (eL) { }
                if (job.attempt < THUMBNAIL_MAX_ATTEMPTS) {
                    // Requeue the SAME job at the BACK so the next queued job
                    // runs first (FIFO, Req 4.2), then this one retries later —
                    // up to THUMBNAIL_MAX_ATTEMPTS (3) total attempts (Req 3.4).
                    job.attempt++;
                    previewQueue.push(job);
                    drainPreviewQueue();
                    return;
                }
                // Retries exhausted — terminal failure. Patch ONLY the affected
                // card into its failure state (retain placeholder + flag for
                // regen), never a full Library_Scan (Req 4.6). The live project
                // is untouched. Advancing the queue here starts the next job
                // immediately, well within the 1-second bound (Req 4.4).
                patchThumbnailCardFailed(job);
                if (job.cb) { try { job.cb(err); } catch (eCb) { } }
                drainPreviewQueue();
                return;
            }
            // Success — swap the placeholder for the rendered thumbnail on the
            // single affected card only, cache-busted, never a full
            // Library_Scan (Req 4.5).
            if (job.cb) { try { job.cb(null); } catch (eCb) { } }
            patchThumbnailCardReady(job);
            drainPreviewQueue();
        });
    }

    // ── Single-card patch helpers (Req 4.5, 4.6) ────────────────────────
    // Derive the template folder that owns a background job's output. The
    // thumbnail is written next to the saved template `project.aep`, so the
    // folder is the parent directory of the output PNG (or of the .aep).
    function jobFolderPath(job) {
        var basis = ("" + (job.outPngPath || job.aepPath || "")).replace(/\\/g, "/");
        return basis.replace(/\/[^\/]*$/, "");
    }

    // Success patch: swap the single card's placeholder for the rendered
    // thumbnail in place. Reuses the global cache-busting swap from
    // templates.js; falls back to the local text-preset grid if unavailable.
    function patchThumbnailCardReady(job) {
        var folderPath = jobFolderPath(job);
        try {
            if (typeof refreshCardThumbnail === "function") {
                refreshCardThumbnail(folderPath, job.outPngPath);
                return;
            }
        } catch (e) { }
        try { refreshFromDisk(); } catch (e2) { }
    }

    // Failure patch: keep the placeholder, keep the card in the Library_Index,
    // and mark the single card's failure state. Best-effort and single-card;
    // never triggers a full Library_Scan (Req 4.6).
    function patchThumbnailCardFailed(job) {
        var folderPath = jobFolderPath(job);
        try {
            if (typeof markCardFailed === "function") { markCardFailed(folderPath); }
        } catch (e) { }
        try {
            if (typeof markThumbnailForRegen === "function") { markThumbnailForRegen(folderPath); }
        } catch (e2) { }
    }

    // Swap the single template card's animated preview in place, cache-busted,
    // without re-scanning the Library_Index (Req 4.5). Matches the card by its
    // owning folder (main template grid) or by preset path (text grid).
    function refreshCardPreview(presetPath) {
        try {
            var norm = ("" + presetPath).replace(/\\/g, "/");
            var apng = previewApngPathFor(norm);
            var version = Date.now();
            var fs = nfs();
            if (fs && fs.statSync) {
                try {
                    var st = fs.statSync(apng);
                    var mt = st.mtimeMs || (st.mtime && st.mtime.getTime());
                    if (mt) version = Math.floor(mt);
                } catch (eStat) { }
            }
            var fwd = apng.charAt(0) === "/" ? apng.substring(1) : apng;
            var url = "file:///" + encodeURI(fwd) + "?v=" + version;
            var folder = norm.replace(/\/[^\/]*$/, "");
            var cards = document.querySelectorAll(".card, .icon-card, .ta-card");
            for (var i = 0; i < cards.length; i++) {
                var c = cards[i];
                var cardFolder = (c.dataset.folder || "").replace(/\\/g, "/");
                var cardPath = (c.dataset.path || "").replace(/\\/g, "/");
                if (cardFolder !== folder && cardPath !== norm) continue;
                c.setAttribute("data-preview", url);
                break;
            }
        } catch (e) {
            try { console.warn("[CompSaver] refreshCardPreview failed:", e); } catch (eL) { }
        }
    }

    // Render one template thumbnail non-destructively via the host
    // `renderTemplateThumbnail` hex-bridge entry point. `done(err)` is invoked
    // exactly once — on the AE result or when the 60s timeout fires first,
    // whichever comes first (a late AE callback after timeout is ignored).
    function runOneThumbnail(job, done) {
        var jobFolder = ("" + job.outPngPath).replace(/\\/g, "/").replace(/\/[^\/]*$/, "");
        markFolderBusy(jobFolder);

        var finished = false;
        var timer = null;
        function finish(err) {
            if (finished) return;
            finished = true;
            if (timer) { try { clearTimeout(timer); } catch (eC) { } timer = null; }
            clearFolderBusy(jobFolder);
            if (done) done(err);
        }

        function log(msg) {
            try { console.log("[CompSaver thumbnail]", job.aepPath, "—", msg); } catch (e) { }
        }

        // Abandon-and-advance guard (Req 10.5): if the render does not report
        // back within 60s, treat the job as failed and let the queue continue.
        timer = setTimeout(function () {
            log("timed out after " + THUMBNAIL_TIMEOUT_MS + "ms — abandoning");
            finish("thumbnail render timed out");
        }, THUMBNAIL_TIMEOUT_MS);

        log("start");

        // Isolated aerender path (Wave A): render in a separate process so
        // the live AE session is never touched. Any failure falls back to
        // the guarded in-project renderer below — external rendering is
        // never mandatory. Requires the comp name; without it we go straight
        // to the in-project path.
        if (typeof AerenderRunner !== "undefined" && job.compName) {
            try {
                AerenderRunner.renderThumbnail({
                    aepPath: job.aepPath,
                    compName: job.compName,
                    frame: (typeof job.renderFrame === "number" && job.renderFrame >= 0) ? job.renderFrame : 0,
                    outPngPath: job.outPngPath
                }, function (res) {
                    if (res && res.ok) {
                        log("isolated aerender wrote thumbnail (" + Math.round(res.durationMs || 0) + "ms)");
                        finish(null);
                        return;
                    }
                    log("isolated aerender unavailable — falling back in-project: " + (res && res.error ? res.error : "unknown"));
                    runInProject();
                });
                return;
            } catch (eAe) {
                log("aerender path threw — falling back in-project: " + eAe);
            }
        }

        runInProject();

        function runInProject() {
            // Req 2.11: forward the comp name + frame the save engine recorded so
            // the in-project fallback renders the same frame aerender would. Both
            // are optional host-side; an empty string means "use the default".
            var frameArg = (typeof job.renderFrame === "number" && job.renderFrame >= 0)
                ? String(job.renderFrame) : "";
            var jsx = 'renderTemplateThumbnail("' +
                encodeBridge(job.aepPath) + '","' +
                encodeBridge(job.outPngPath) + '","' +
                encodeBridge(job.compName || "") + '","' +
                encodeBridge(frameArg) + '")';

            try {
                csInterface.evalScript(jsx, function (hex) {
                    var res = {};
                    try { res = JSON.parse(decodeBridge(hex || "")); }
                    catch (e) { res = { ok: false, error: decodeBridge(hex || "") }; }
                    if (!res.ok) {
                        log("AE render failed: " + (res.error || "unknown"));
                        finish("AE thumbnail: " + (res.error || "unknown"));
                        return;
                    }
                    log("AE wrote thumbnail");
                    finish(null);
                });
            } catch (eEval) {
                finish("evalScript failed: " + (eEval && eEval.message ? eEval.message : eEval));
            }
        }
    }

    // Main entry point for background thumbnail rendering. Queues a thumbnail
    // render on the shared serialized queue so it never overlaps preview jobs
    // and runs in FIFO order with them. `onDone(err)` fires when the job
    // reaches its terminal outcome (success or exhausted single retry).
    //
    //   aepPath    - absolute path to the saved template project.aep
    //   outPngPath - absolute path where thumbnail.png should be written
    //   onDone     - optional cb(err) when this thumbnail job completes
    function enqueueThumbnailRender(aepPath, outPngPath, onDone, compName, renderFrame) {
        if (!aepPath || !outPngPath) { if (onDone) onDone("no path"); return; }
        previewQueue.push({
            type: "thumbnail",
            aepPath: aepPath,
            outPngPath: outPngPath,
            compName: compName || null,          // exact comp in the AEP (aerender path)
            renderFrame: (typeof renderFrame === "number" && renderFrame >= 0) ? renderFrame : 0,
            cb: onDone,
            attempt: 1
        });
        if (!previewRunning) drainPreviewQueue();
    }

    function runOnePreview(job, done) {
        // Mark the template folder busy for the whole render so concurrent
        // delete operations skip it. Wrapping `done` guarantees the flag is
        // cleared on every exit path (success, AE failure, ffmpeg failure).
        var jobFolder = ("" + job.path).replace(/\\/g, "/").replace(/\/[^\/]*$/, "");
        markFolderBusy(jobFolder);
        var _origDone = done;
        var _finished = false;
        // 60s per-job budget (Req 4.4): every preview job is bounded exactly
        // like a thumbnail job. If the render throws or never reports back
        // within JOB_BUDGET_MS the job is marked failed here and `done` fires
        // once, letting the runner advance to the next queued job. The
        // `_finished` guard ensures a late AE/ffmpeg callback after the budget
        // expires is ignored.
        var _budgetTimer = setTimeout(function () {
            done("preview render exceeded 60s budget");
        }, JOB_BUDGET_MS);
        done = function (err) {
            if (_finished) return;
            _finished = true;
            if (_budgetTimer) { try { clearTimeout(_budgetTimer); } catch (eC) { } _budgetTimer = null; }
            clearFolderBusy(jobFolder);
            if (_origDone) _origDone(err);
        };

        function log(msg) {
            try { console.log("[CompSaver preview]", job.path, "—", msg); } catch (e) { }
        }
        log("start");
        resolveFfmpeg(function (ffmpeg) {
            if (!ffmpeg) {
                log("ffmpeg unavailable");
                done("preview encoder unavailable");
                return;
            }
            log("ffmpeg: " + ffmpeg);
            var tempDir = makePreviewTempDir();
            if (!tempDir) { log("temp dir creation failed"); done("Could not create temp dir"); return; }
            log("temp dir: " + tempDir);

            var jsx = 'taRenderPresetPreview("' +
                encodeBridge(job.path) + '","' +
                encodeBridge(tempDir) + '","' +
                encodeBridge(job.label) + '")';

            csInterface.evalScript(jsx, function (hex) {
                var res = {};
                try { res = JSON.parse(decodeBridge(hex || "")); }
                catch (e) { res = { ok: false, error: decodeBridge(hex || "") }; }

                if (!res.ok) {
                    log("AE render failed: " + (res.error || "unknown"));
                    rmTempDir(tempDir);
                    done("AE render: " + (res.error || "unknown"));
                    return;
                }
                log("AE wrote " + res.frameCount + " frames @ " + res.frameRate + "fps" +
                    " (keyframesFound=" + (typeof res.keyframesFound === "number" ? res.keyframesFound : "?") + ")");
                if (res.keyframesFound === 0) {
                    // Not a fallback: the JSX still rendered a valid clip via
                    // the default/expression/animator path. Log so a "why is
                    // this one different" question has a paper trail.
                    log("note: preset had no transform keyframes — rendered via default-duration path (expression/animator/source-text or static)");
                }

                var outApng = previewApngPathFor(job.path);
                log("encoding APNG to: " + outApng);

                var fs = nfs();
                var inputName = "";
                var inputIsSequence = false;
                var seqStartNumber = 0;
                var seqFrameCount = 0;

                if (res.debugScan) {
                    log("debugScan: " + res.debugScan);
                }

                // Preferred input: PNG sequence written headlessly by
                // saveFrameToPng() — pattern comes back as framePattern
                // (e.g. "preview_%05d.png"). We scan the temp dir for the
                // ACTUAL written frames instead of trusting any hardcoded
                // start index — the renderer might be 0-based today and
                // 1-based tomorrow, and ffmpeg's image2 demuxer defaults
                // to start_number=1, which silently skips frame 0. We
                // detect the lowest existing index and feed it through.
                //
                // Fallback: legacy single-file video ("preview_render.*")
                // in case any in-flight job from a previous build still
                // uses the RQ path.
                try {
                    if (fs) {
                        var files = fs.readdirSync(tempDir);
                        var pngRe = /^preview_(\d+)\.png$/i;
                        // DISK-TRUTH: build the set of indices that ACTUALLY
                        // exist on disk. Never derive a frame list from
                        // duration*fps — only feed FFmpeg what is really there.
                        var present = {};
                        var minIdx = -1;
                        var pngCount = 0;
                        var videoFound = "";
                        for (var i = 0; i < files.length; i++) {
                            var fn = files[i];
                            var m = pngRe.exec(fn);
                            if (m) {
                                pngCount++;
                                var n = parseInt(m[1], 10);
                                present[n] = true;
                                if (minIdx < 0 || n < minIdx) minIdx = n;
                            } else if (!videoFound && fn.indexOf("preview_render") === 0) {
                                videoFound = fn;
                            }
                        }
                        if (pngCount > 0 && res.framePattern) {
                            // FFmpeg's image2 pattern reads contiguously from
                            // -start_number and stops at the first gap. Count
                            // only the unbroken run from minIdx so we never
                            // claim (or reference) frames past a hole.
                            var contig = 0;
                            var c = minIdx;
                            while (present[c]) { contig++; c++; }
                            if (contig < pngCount) {
                                log("WARN: " + (pngCount - contig) + " orphan PNG(s) after a gap — using contiguous run of " + contig);
                            }
                            inputName = res.framePattern;
                            inputIsSequence = true;
                            seqStartNumber = (minIdx >= 0) ? minIdx : 0;
                            seqFrameCount = contig;
                            log("PNG sequence: " + contig + " frame(s) on disk, starting at " + seqStartNumber);
                        } else if (videoFound) {
                            inputName = videoFound;
                            inputIsSequence = false;
                        }
                    }
                } catch (eFs) { }

                if (!inputName) {
                    log("Error: no rendered frames or video found in temp dir");
                    rmTempDir(tempDir);
                    done("No rendered output found");
                    return;
                }

                if (seqFrameCount > 120) {
                    log("compressing " + seqFrameCount + " frames → ~120 (APNG plays in ~4s, full animation sped up)");
                }
                encodeApng(ffmpeg, tempDir, inputName, res.frameRate, outApng, inputIsSequence, seqStartNumber, seqFrameCount, function (encErr) {
                    rmTempDir(tempDir);
                    if (encErr) { log("ffmpeg failed: " + encErr); done("ffmpeg failed: " + encErr); return; }
                    log("APNG written (" + seqFrameCount + " source frames)");

                    if (/\.aep$/i.test(job.path)) {
                        var fs = nfs();
                        var nodePath = getNodePath();
                        if (fs && nodePath) {
                            try {
                                var dir = nodePath.dirname(job.path);
                                var metaPath = nodePath.join(dir, "meta.json");
                                if (fs.existsSync(metaPath)) {
                                    var metaContent = fs.readFileSync(metaPath, "utf8");
                                    var metaData = JSON.parse(metaContent);
                                    metaData.hasFrames = true;
                                    metaData.frameCount = seqFrameCount;
                                    fs.writeFileSync(metaPath, JSON.stringify(metaData), "utf8");
                                    log("Stamped hasFrames/frameCount into meta.json");
                                }
                            } catch (eMeta) {
                                log("Error writing meta.json: " + eMeta);
                            }
                        }
                    }
                    done(null);
                });
            });
        });
    }

    // ── Custom Context Menu for Text Animation Preset Cards ─────────────
    var contextMenu = null;
    function getContextMenu() {
        if (contextMenu) return contextMenu;
        contextMenu = document.createElement("div");
        contextMenu.className = "ta-custom-context-menu";
        contextMenu.innerHTML =
            '<div class="ta-context-item" data-act="rename">' +
            '  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
            '  <span>Rename</span>' +
            '</div>' +
            '<div class="ta-context-item ta-context-item--danger" data-act="delete">' +
            '  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
            '  <span>Delete</span>' +
            '</div>';
        document.body.appendChild(contextMenu);

        // Click on items
        contextMenu.addEventListener("click", function (e) {
            var item = e.target.closest(".ta-context-item");
            if (!item) return;
            var act = item.dataset.act;
            var path = contextMenu.dataset.path;
            var name = contextMenu.dataset.name;
            closeContextMenu();

            if (act === "delete") {
                deleteOne(path);
            } else if (act === "rename") {
                openRenameModal(path, name);
            }
        });

        // Hide when clicking outside
        document.addEventListener("mousedown", function (e) {
            if (contextMenu && !contextMenu.contains(e.target)) {
                closeContextMenu();
            }
        });

        return contextMenu;
    }

    function showContextMenu(x, y, card) {
        var menu = getContextMenu();
        menu.dataset.path = card.dataset.path;
        menu.dataset.name = card.dataset.name;
        menu.style.display = "block";

        // Reposition so the menu stays FULLY inside the viewport (Req 13.5, 13.6).
        // Measure the actual rendered size (block already shown) instead of relying
        // on fixed estimates, then clamp on all four edges. The Math.max(margin, …)
        // lower bound prevents the menu from spilling past the top/left edge when
        // the trigger point is near the panel's right/bottom corner.
        var margin = 5;
        var rect = menu.getBoundingClientRect();
        var menuWidth = rect.width || 110;
        var menuHeight = rect.height || 60;
        var maxX = window.innerWidth - menuWidth - margin;
        var maxY = window.innerHeight - menuHeight - margin;
        var posX = Math.max(margin, Math.min(x, maxX));
        var posY = Math.max(margin, Math.min(y, maxY));

        menu.style.left = posX + "px";
        menu.style.top = posY + "px";
        card.classList.add("context-menu-active");
    }

    function removeContextMenuHighlight() {
        var activeCards = document.querySelectorAll(".ta-card.context-menu-active");
        for (var i = 0; i < activeCards.length; i++) {
            activeCards[i].classList.remove("context-menu-active");
        }
    }

    function closeContextMenu() {
        if (contextMenu) {
            contextMenu.style.display = "none";
        }
        removeContextMenuHighlight();
    }

    // ── Event wiring (once) ──────────────────────────────────────────────
    function bind() {
        // Search
        var search = document.getElementById("ta-search-input");
        if (search) {
            search.addEventListener("input", function () {
                searchQuery = this.value || "";
                render();
            });
        }

        // Save / refresh / import / bulk
        var btnSave = document.getElementById("btn-ta-save");
        if (btnSave) btnSave.addEventListener("click", openSaveModal);

        var btnRefresh = document.getElementById("btn-ta-refresh");
        if (btnRefresh) btnRefresh.addEventListener("click", function (e) {
            var b = this; b.classList.add("spinning");
            // Shift-click: regenerate previews for everything in current view.
            if (e.shiftKey) {
                setTimeout(function () {
                    b.classList.remove("spinning");
                    backfillPreviewsForCurrentView();
                }, 200);
                return;
            }
            setTimeout(function () { refreshFromDisk(); b.classList.remove("spinning"); showToast("Refreshed", "success"); }, 300);
        });

        var btnImport = document.getElementById("btn-ta-import");
        if (btnImport) btnImport.addEventListener("click", importFiles);

        var btnBulk = document.getElementById("btn-ta-bulk-toggle");
        if (btnBulk) btnBulk.addEventListener("click", function () {
            var confirm = document.getElementById("ta-bulk-confirm");
            if (bulkMode && bulkSelected.length > 0) { if (confirm) confirm.classList.add("show"); return; }
            setBulkMode(!bulkMode);
        });

        var btnBulkConfirm = document.getElementById("btn-ta-bulk-confirm");
        if (btnBulkConfirm) btnBulkConfirm.addEventListener("click", performBulkDelete);
        var btnBulkCancel = document.getElementById("btn-ta-bulk-cancel");
        if (btnBulkCancel) btnBulkCancel.addEventListener("click", function () {
            var confirm = document.getElementById("ta-bulk-confirm");
            if (confirm) confirm.classList.remove("show");
        });

        var btnReset = document.getElementById("btn-ta-reset");
        if (btnReset) btnReset.addEventListener("click", resetTextLayers);

        // Category toggle button and dropdown
        var menuBtn = document.getElementById("ta-menu-toggle-btn");
        var menuDropdown = document.getElementById("ta-dropdown-menu");
        if (menuBtn && menuDropdown) {
            menuBtn.addEventListener("click", function (e) {
                e.stopPropagation();
                e.preventDefault();
                menuDropdown.classList.toggle("open");
            });

            document.addEventListener("click", function (e) {
                var dd = document.getElementById("ta-dropdown-menu");
                var mb = document.getElementById("ta-menu-toggle-btn");
                if (dd && !dd.contains(e.target) && (!mb || !mb.contains(e.target))) {
                    dd.classList.remove("open");
                }
            });
        }

        var tabAll = document.getElementById("btn-ta-cat-all");
        if (tabAll) {
            tabAll.addEventListener("click", function (e) {
                e.stopPropagation();
                e.preventDefault();
                setCategory("All");
            });
        }

        var tabFav = document.getElementById("btn-ta-cat-fav");
        if (tabFav) {
            tabFav.addEventListener("click", function (e) {
                e.stopPropagation();
                e.preventDefault();
                setCategory("★ Fav");
            });
        }

        // Save modal: name enter + category select + buttons
        var nameInput = document.getElementById("ta-name-input");
        if (nameInput) nameInput.addEventListener("keydown", function (e) { if (e.key === "Enter") confirmSave(); });

        var modalCatTrigger = document.getElementById("ta-modal-cat-trigger");
        var modalCatWrap = document.getElementById("ta-modal-cat-wrapper");
        if (modalCatTrigger && modalCatWrap) {
            modalCatTrigger.addEventListener("click", function (e) {
                e.stopPropagation();
                modalCatWrap.classList.toggle("open");
            });
        }
        var modalCatDd = document.getElementById("ta-modal-cat-dropdown");
        if (modalCatDd) {
            modalCatDd.addEventListener("click", function (e) {
                var opt = e.target.closest(".custom-select-option");
                if (!opt) return;
                pendingSaveCat = opt.dataset.cat;
                var valEl = document.getElementById("ta-modal-cat-value");
                if (valEl) valEl.textContent = pendingSaveCat;
                var all = modalCatDd.querySelectorAll(".custom-select-option");
                for (var i = 0; i < all.length; i++) all[i].classList.toggle("active", all[i] === opt);
                if (modalCatWrap) modalCatWrap.classList.remove("open");
            });
        }
        var btnSaveCancel = document.getElementById("btn-ta-save-cancel");
        if (btnSaveCancel) btnSaveCancel.addEventListener("click", function () {
            FocusTrap.deactivate();
            var modal = document.getElementById("ta-save-modal");
            if (modal) modal.classList.remove("open");
        });
        var btnSaveConfirm = document.getElementById("btn-ta-save-confirm");
        if (btnSaveConfirm) btnSaveConfirm.addEventListener("click", confirmSave);

        // Preset rename modal
        var renameInput = document.getElementById("ta-preset-rename-input");
        if (renameInput) renameInput.addEventListener("keydown", function (e) { if (e.key === "Enter") confirmRename(); });
        var btnRenameCancel = document.getElementById("btn-ta-preset-rename-cancel");
        if (btnRenameCancel) btnRenameCancel.addEventListener("click", function () {
            FocusTrap.deactivate();
            var modal = document.getElementById("ta-preset-rename-modal");
            if (modal) modal.classList.remove("open");
            pendingRenamePath = "";
        });
        var btnRenameConfirm = document.getElementById("btn-ta-preset-rename-confirm");
        if (btnRenameConfirm) btnRenameConfirm.addEventListener("click", confirmRename);

        // Backdrop click to dismiss TextAnim modals
        var taSaveModal = document.getElementById("ta-save-modal");
        if (taSaveModal) {
            taSaveModal.addEventListener("click", function (e) {
                if (e.target === taSaveModal) {
                    FocusTrap.deactivate();
                    taSaveModal.classList.remove("open");
                }
            });
        }
        var taRenameModal = document.getElementById("ta-preset-rename-modal");
        if (taRenameModal) {
            taRenameModal.addEventListener("click", function (e) {
                if (e.target === taRenameModal) {
                    FocusTrap.deactivate();
                    taRenameModal.classList.remove("open");
                    pendingRenamePath = "";
                }
            });
        }

        // Grid delegation: delete / favorite / bulk-select / apply
        var grid = document.getElementById("ta-grid");
        if (grid) {
            grid.addEventListener("click", function (e) {
                var card = e.target.closest(".ta-card");
                if (!card) return;
                var path = card.dataset.path;

                var actBtn = e.target.closest("[data-ta-act]");
                if (actBtn) {
                    e.stopPropagation();
                    var act = actBtn.dataset.taAct;
                    if (act === "delete") { deleteOne(path); return; }
                    if (act === "rename") { openRenameModal(path, card.dataset.name || ""); return; }
                    if (act === "favorite") {
                        var file = card.dataset.file;
                        var favs = getFavorites();
                        setFavorite(file, !favs[file]);
                        refreshFromDisk();
                        return;
                    }
                }

                if (bulkMode) {
                    e.preventDefault();
                    var idx = bulkSelected.indexOf(path);
                    if (idx > -1) { bulkSelected.splice(idx, 1); card.classList.remove("selected-for-delete"); }
                    else { bulkSelected.push(path); card.classList.add("selected-for-delete"); }
                    updateBulkCount();
                    return;
                }

                // Single click → instant apply
                applyPreset(path);
            });

            grid.addEventListener("contextmenu", function (e) {
                var card = e.target.closest(".ta-card");
                if (!card) return;
                e.preventDefault();
                e.stopPropagation();
                closeContextMenu();
                showContextMenu(e.clientX, e.clientY, card);
            });
        }
    }

    // ── Public ───────────────────────────────────────────────────────────
    return {
        init: function () {
            if (initialized) return;
            initialized = true;
            if (typeof FeatureFlags !== "undefined" && FeatureFlags.flags.lifecycleV1 &&
                typeof AppLifecycle !== "undefined") {
                AppLifecycle.onDispose(function () {
                    previewQueue.length = 0;
                    previewRunning = false;
                    previewCurrentJob = null;
                    if (drainPreviewQueue._laneRelease) {
                        var release = drainPreviewQueue._laneRelease;
                        drainPreviewQueue._laneRelease = null;
                        drainPreviewQueue._laneOwned = false;
                        release();
                    }
                    initialized = false;
                });
            }
            bind();
            bindAllGridContainers();
            setCategory("All");
            resolveDir(function () {
                migrateOldTextPresets();
                refreshFromDisk();
            });
        },
        load: function () {
            // Called each time the Text tab is shown
            if (!initialized) { this.init(); return; }
            searchQuery = "";
            var search = document.getElementById("ta-search-input");
            if (search) search.value = "";
            setCategory("All");
            resolveDir(function () { refreshFromDisk(); });
        },
        enqueuePreviewRender: enqueuePreviewRender,
        enqueueThumbnailRender: enqueueThumbnailRender,
        attachHoverPreviews: attachHoverPreviews,
        bindAllGridContainers: bindAllGridContainers,
        previewApngPathFor: previewApngPathFor,
        getPresets: getPresets,
        applyPreset: applyPreset,
        onPresetsChanged: onPresetsChanged
    };
})();

if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () {
            if (typeof TextAnim !== "undefined" && TextAnim.bindAllGridContainers) {
                TextAnim.bindAllGridContainers();
            }
        });
    } else {
        if (typeof TextAnim !== "undefined" && TextAnim.bindAllGridContainers) {
            TextAnim.bindAllGridContainers();
        }
    }
}
