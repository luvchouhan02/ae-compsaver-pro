// ============================================================
// toolkit/effects.js - Effects Presets engine
// ------------------------------------------------------------
// Scan / save / apply / favorite / rename / delete / bulk-import of
// .ffx-.cseffect presets, category system, fs.watch live refresh, and
// grid rendering. Moved verbatim from main.js. Depends on globals:
// showToast, resolveNodeModules/nodeFs (core/node.js), csInterface,
// encodeBridge/decodeBridge, getSafeName, escapeHTML/escapeAttr,
// bindClick/setDisplay/setActive, DOM. loadSavedEffects() is called
// from switchToolkitSubSection()/init()/window-focus in main.js.
// Loaded before main.js.
// ============================================================

// =========================================================
// EFFECTS PRESETS ENGINE
// Architecture:
//   - Canonical presets path is resolved by JSX (getAEUserPresetsPath)
//     and mirrored here so Node.js can watch the folder for changes.
//   - Save  → toolkitSaveEffectPreset()  (silent, no dialog)
//   - Apply → toolkitApplyEffectPreset() (one-click paste to layer)
//   - Scan  → toolkitGetEffectsScan()    (JSX scans on init + after save)
// =========================================================

// Node.js module resolver (nodeFs / nodePath / nodeOs + resolveNodeModules)
// lives in core/node.js, loaded before this file.

// ── State ──────────────────────────────────────────────────────────────
var EFFECTS_DIR = "";
var savedEffectsCache = [];
var favoriteEffects = loadFavoriteEffects();
var effectsWatcher = null;   // fs.watch instance for live refresh
var effectsSearchQuery = "";    // In-memory smart search query (filterEffects uses it; no input wired yet)
var effectsRenameLock = false;   // Lock live refresh during active renaming
var effectsOutsideClickWired = false; // Guard: register the document outside-click handler only once
// Freshness stamp of the last completed scanEffectsFolder() (epoch ms + scanned
// roots). Lets loadSavedEffects() skip redundant rescans on focus/sub-tab
// re-entry; every direct scanEffectsFolder() caller (mutations, refresh,
// fs.watch) restamps automatically, so cached knowledge is never older than
// the last real scan.
var effectsScanFreshness = { at: 0, key: "" };

var OneFramers = (function () {
    var recipes = [];
    var pending = null;
    var query = "";

    function load() {
        if (recipes.length) { render(); return Promise.resolve(recipes); }
        if (pending) return pending;
        pending = Promise.resolve().then(function () {
            if (typeof resolveNodeModules === "function" && resolveNodeModules()) {
                var base = csInterface.getSystemPath(SystemPath.EXTENSION);
                return JSON.parse(nodeFs.readFileSync(nodePath.join(base, "presets", "oneframers_106_recipes.json"), "utf8"));
            }
            return fetch("presets/oneframers_106_recipes.json").then(function (response) {
                if (!response.ok) throw new Error("Recipe catalog could not be loaded");
                return response.json();
            });
        }).then(function (catalog) {
            if (!Array.isArray(catalog) || catalog.length !== 106 || catalog.some(function (recipe) { return !recipe.name || !Array.isArray(recipe.effects); })) throw new Error("Invalid One-Framer catalog");
            recipes = catalog;
            render();
            return recipes;
        }).catch(function (error) {
            pending = null;
            var grid = document.getElementById("cs-oneframer-grid");
            if (grid) grid.textContent = "One-Framers unavailable. Reopen this section to retry.";
            throw error;
        });
        return pending;
    }

    function apply(name, button) {
        var recipe = recipes.filter(function (entry) { return entry.name === name; })[0];
        if (!recipe) { showToast("One-Framer is not available", "warning"); return; }
        return ToolBridge.call({
            key: "oneframer.apply",
            script: 'toolkitApplyOneFramer("' + encodeBridge(JSON.stringify(recipe)) + '")',
            button: button || null,
            timeoutMs: 30000,
            onResult: function (result) { reportToolkitResult("oneframer", name, result, button); }
        });
    }

    function render() {
        var grid = document.getElementById("cs-oneframer-grid");
        if (!grid) return;
        var visible = recipes.filter(function (recipe) { return recipe.name.toLowerCase().indexOf(query) !== -1; });
        grid.textContent = "";
        var fragment = document.createDocumentFragment();
        visible.forEach(function (recipe) {
            var button = document.createElement("button");
            button.type = "button";
            button.className = "cs-oneframer";
            button.setAttribute("data-oneframer", recipe.name);
            button.title = recipe.name;
            var swatch = document.createElement("span");
            swatch.className = "cs-oneframer-swatch";
            swatch.setAttribute("aria-hidden", "true");
            var color = (recipe.color || [0.4, 0.6, 0.8]).map(function (value) { return Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 255); });
            swatch.style.backgroundColor = "rgb(" + color.join(",") + ")";
            var label = document.createElement("span");
            label.textContent = recipe.name;
            button.appendChild(swatch);
            button.appendChild(label);
            fragment.appendChild(button);
        });
        grid.appendChild(fragment);
        if (!visible.length) grid.textContent = "No matching One-Framers";
        var count = document.getElementById("cs-oneframer-count");
        if (count) count.textContent = visible.length + " / " + recipes.length;
    }

    function init() {
        var section = document.getElementById("cs-oneframers");
        if (!section) return;
        if (!section.dataset.bound) {
            section.dataset.bound = "true";
            section.addEventListener("toggle", function () { if (section.open) load().catch(function (error) { showToast(error.message, "error"); }); });
            document.getElementById("cs-oneframer-search").addEventListener("input", function () { query = this.value.trim().toLowerCase(); render(); });
            document.getElementById("cs-oneframer-grid").addEventListener("click", function (event) {
                var button = event.target.closest("[data-oneframer]");
                if (button) apply(button.getAttribute("data-oneframer"), button);
            });
        }
        load().catch(function (error) { showToast(error.message, "error"); });
    }

    return { init: init, load: load, apply: apply, getRecipes: function () { return recipes.slice(); } };
})();

// ── Favorite persistence (survives panel reload / AE restart) ─────────
var FAV_EFFECTS_KEY = "cs_effects_favorites";
function loadFavoriteEffects() {
    try {
        var raw = localStorage.getItem(FAV_EFFECTS_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
}
function saveFavoriteEffects() {
    try { localStorage.setItem(FAV_EFFECTS_KEY, JSON.stringify(favoriteEffects)); } catch (e) { }
}

// ── Whitelist Path Resolvers ──────────────────────────────────────────
function getActiveEffectsDir() {
    if (rootPath) return rootPath.replace(/\/+$/, "") + "/effects";
    var legacy = getLegacyEffectsDir();
    if (legacy) return legacy;
    return "";
}

function getLegacyEffectsDir() {
    var userProfile = "";
    if (typeof process !== "undefined" && process.env) {
        userProfile = process.env.USERPROFILE || process.env.HOME || "";
    }
    if (!userProfile && resolveNodeModules() && nodeOs) {
        try { userProfile = nodeOs.homedir(); } catch (e) { }
    }
    if (!userProfile) return "";
    return userProfile.replace(/\\/g, "/").replace(/\/+$/, "") + "/Documents/LAB_PRO_Effects";
}

// ── fs.watch live refresh ─────────────────────────────────────────────
function startFolderWatch() {
    if (!Settings.get("performance.liveFolderWatch")) return;
    var activeDir = getActiveEffectsDir();
    if (!activeDir) return;
    stopFolderWatch();
    if (!resolveNodeModules()) return;
    try {
        if (!nodeFs.existsSync(activeDir)) return;
        effectsWatcher = nodeFs.watch(activeDir, { persistent: false }, function (eventType, filename) {
            if (effectsRenameLock) return; // Prevent live refresh during active renaming!
            if (!filename || !/\.(ffx|cseffect)$/i.test(filename)) return;
            clearTimeout(effectsWatcher._debounce);
            effectsWatcher._debounce = setTimeout(function () {
                var grid = document.getElementById("tk-effects-grid");
                if (!grid) return;
                var files = scanEffectsFolder();
                savedEffectsCache = files;
                renderCategorySystem(files);
                renderEffectsGridOrEmpty(grid, filterEffects(files));
            }, 400);
        });
        effectsWatcher._debounce = null;
        if (typeof FeatureFlags !== "undefined" && FeatureFlags.flags.lifecycleV1 &&
            typeof AppLifecycle !== "undefined") {
            var ownedWatcher = effectsWatcher;
            effectsWatcher._lifecycleToken = AppLifecycle.register("watcher", ownedWatcher, function () {
                if (ownedWatcher._debounce) clearTimeout(ownedWatcher._debounce);
                try { ownedWatcher.close(); } catch (eClose) { }
                if (effectsWatcher === ownedWatcher) effectsWatcher = null;
            });
        }
        console.log("[Effects] Watching active custom folder:", activeDir);
    } catch (e) {
        console.warn("[Effects] fs.watch not available:", e.message);
    }
}

function stopFolderWatch() {
    if (effectsWatcher) {
        if (effectsWatcher._debounce) clearTimeout(effectsWatcher._debounce);
        var token = effectsWatcher._lifecycleToken;
        if (token) token.dispose();
        else { try { effectsWatcher.close(); } catch (e) { } effectsWatcher = null; }
    }
}

// ── Whitelisted Aggregated Filesystem Scan (Node.js) ──────────────────
function scanEffectsFolder() {
    if (!resolveNodeModules()) return [];
    var activeDir = getActiveEffectsDir();
    var legacyDir = getLegacyEffectsDir();
    var results = [];
    var seen = {};

    // One localStorage round-trip per scan, not per file: the map is loaded
    // up front, mutated in memory, and persisted once. The previous per-file
    // getStoredOriginalName()/setStoredOriginalName() pattern re-parsed and
    // re-serialized the whole growing map for every preset (O(N²) JSON churn
    // on the UI thread, paid again on every focus-rescan).
    var origNamesMap = getStoredOriginalNames();
    var origNamesDirty = false;

    function scanDirRecursive(baseDir, currentDir, source) {
        if (!currentDir || !nodeFs.existsSync(currentDir)) return;
        try {
            var entries = nodeFs.readdirSync(currentDir);
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                var fullPath = currentDir.replace(/\\/g, "/").replace(/\/+$/, "") + "/" + entry;
                var stat = nodeFs.statSync(fullPath);

                if (stat.isDirectory()) {
                    scanDirRecursive(baseDir, fullPath, source);
                } else if (typeof entry === "string" && /\.(ffx|cseffect)$/i.test(entry)) {
                    var lowerName = entry.toLowerCase();
                    if (!seen[lowerName]) {
                        seen[lowerName] = true;
                        var baseName = entry.replace(/\.(ffx|cseffect)$/i, "");

                        // Determine category based on parent sub-folder relative to baseDir
                        var category = "ALL";
                        var relativePath = currentDir.substring(baseDir.length).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
                        if (relativePath) {
                            var pathParts = relativePath.split("/");
                            category = pathParts[pathParts.length - 1].toUpperCase();
                        } else {
                            category = "GENERAL";
                        }

                        var origName = origNamesMap[entry] || baseName;

                        if (!origNamesMap[entry]) {
                            origNamesMap[entry] = baseName;
                            origNamesDirty = true;
                        }

                        results.push({
                            file: entry,
                            path: fullPath,
                            source: source,
                            displayName: baseName,
                            originalName: origName,
                            category: category
                        });
                    }
                }
            }
        } catch (e) {
            console.warn("[Effects] Error scanning path:", currentDir, e.message);
        }
    }

    scanDirRecursive(activeDir, activeDir, "internal");
    scanDirRecursive(legacyDir, legacyDir, "legacy");

    if (origNamesDirty) {
        saveStoredOriginalNames(origNamesMap);
    }

    results.sort(function (a, b) {
        return a.file.toLowerCase().localeCompare(b.file.toLowerCase());
    });

    // Establish a stable original index order to lock card positions post-rename
    for (var idx = 0; idx < results.length; idx++) {
        results[idx].order = idx;
    }

    // Restamp freshness so focus/sub-tab re-entry within the TTL can skip
    // this whole walk (see loadSavedEffects).
    effectsScanFreshness.at = Date.now();
    effectsScanFreshness.key = activeDir + "\n" + legacyDir;

    return results;
}

// ── Save handler ──────────────────────────────────────────────────────
function handleEffectSave(btn) {
    var activeDir = getActiveEffectsDir();
    if (!activeDir) {
        showToast("Presets directory not initialized", "error");
        return;
    }

    var checkScript =
        "(function() {\n" +
        "    var comp = app.project.activeItem;\n" +
        "    if (!comp || !(comp instanceof CompItem)) return 'no_comp';\n" +
        "    var sel = comp.selectedLayers;\n" +
        "    if (!sel || sel.length !== 1) return 'no_layer';\n" +
        "    var targetEffect = (typeof getTargetEffectForSave === 'function') ? getTargetEffectForSave() : null;\n" +
        "    if (targetEffect) return 'ok';\n" +
        "    var layer = sel[0];\n" +
        "    var fxGroup = null;\n" +
        "    try { fxGroup = layer.property('ADBE Effect Parade'); } catch(e) {\n" +
        "        try { fxGroup = layer.Effects; } catch(e2) { return 'no_effect'; }\n" +
        "    }\n" +
        "    if (!fxGroup || fxGroup.numProperties === 0) return 'no_effect';\n" +
        "    return 'ok';\n" +
        "})();";

    ToolBridge.call({
        key: "effects.save",
        script: checkScript,
        button: btn,
        onResult: function (result) {
            if (result.status !== "success") return; // timeout/host error already toasted
            var status = result.decoded;
            if (status === "no_comp") {
                showToast("Open a composition first", "error");
                return;
            }
            if (status === "no_layer") {
                showToast("Select exactly one layer", "error");
                return;
            }
            if (status !== "ok") {
                showToast("Please select an effect first", "error");
                return;
            }

            proceedWithSave();
        }
    });

    function proceedWithSave() {
        // Fetch categories dynamically
        var categories = ["GENERAL"];
        if (resolveNodeModules()) {
            try {
                if (nodeFs.existsSync(activeDir)) {
                    var entries = nodeFs.readdirSync(activeDir);
                    for (var i = 0; i < entries.length; i++) {
                        var entryName = entries[i];
                        var fullPath = activeDir.replace(/\/+$/, "") + "/" + entryName;
                        var stat = nodeFs.statSync(fullPath);
                        if (stat.isDirectory()) {
                            var upper = entryName.toUpperCase();
                            if (upper !== "GENERAL" && categories.indexOf(upper) === -1) {
                                categories.push(upper);
                            }
                        }
                    }
                }
            } catch (e) { }
        }

        // Populate dropdown
        var select = document.getElementById("tk-save-preset-category-select");
        if (select) {
            select.innerHTML = "";
            for (var j = 0; j < categories.length; j++) {
                var opt = document.createElement("option");
                opt.value = categories[j];
                opt.textContent = categories[j];
                select.appendChild(opt);
            }
        }

        // Reset inputs
        var nameInput = document.getElementById("tk-preset-name-input");
        var newCatInput = document.getElementById("tk-save-preset-new-category-input");
        if (nameInput) nameInput.value = "";
        if (newCatInput) newCatInput.value = "";

        // Open modal
        var modal = document.getElementById("tk-save-preset-modal");
        if (modal) {
            modal.classList.add("open");
            FocusTrap.activate(modal);
        }

        // Dynamic ExtendScript retrieval of highlighted effect
        var script =
            "(function() {\n" +
            "    var eff = (typeof getTargetEffectForSave === 'function') ? getTargetEffectForSave() : null;\n" +
            "    if (eff && eff.name) return eff.name;\n" +
            "    var comp = app.project.activeItem;\n" +
            "    if (!comp || !(comp instanceof CompItem)) return '';\n" +
            "    var sel = comp.selectedLayers;\n" +
            "    if (!sel || sel.length !== 1) return '';\n" +
            "    return sel[0].name;\n" +
            "})();";

        var modalSettled = false;
        var modalTimer = setTimeout(function () {
            if (!modalSettled) {
                modalSettled = true;
                if (nameInput) {
                    nameInput.focus();
                    nameInput.select();
                }
            }
        }, 3000);

        csInterface.evalScript(script, function (resName) {
            if (modalSettled) return;
            modalSettled = true;
            clearTimeout(modalTimer);
            var defaultName = "";
            if (resName && resName !== "EvalScript error." && resName !== "undefined" && resName !== "null") {
                defaultName = resName.trim();
            }
            if (nameInput) {
                nameInput.value = defaultName;
                nameInput.focus();
                nameInput.select();
            }
        });
    }
}

function confirmPresetSave() {
    var nameInput = document.getElementById("tk-preset-name-input");
    var select = document.getElementById("tk-save-preset-category-select");
    var newCatInput = document.getElementById("tk-save-preset-new-category-input");
    var modal = document.getElementById("tk-save-preset-modal");

    var customName = nameInput ? nameInput.value.trim() : "";
    if (!customName) {
        showToast("Please enter a preset name", "error");
        return;
    }

    var activeDir = getActiveEffectsDir();
    if (!activeDir) {
        showToast("Presets directory not initialized", "error");
        return;
    }

    var category = "GENERAL";
    var newCatName = newCatInput ? newCatInput.value.trim() : "";
    if (newCatName) {
        category = newCatName.toUpperCase();
    } else if (select) {
        category = select.value;
    }

    var targetDir = activeDir.replace(/\/+$/, "") + "/" + category;

    // Synchronous category creation via Node.js fs
    if (resolveNodeModules()) {
        try {
            if (!nodeFs.existsSync(targetDir)) {
                nodeFs.mkdirSync(targetDir, { recursive: true });
            }
        } catch (err) {
            console.error("Failed to create category folder:", err.message);
            showToast("Failed to create category folder", "error");
            return;
        }
    }

    // Temporary Rename and Save ExtendScript snippet
    var escapedName = customName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    var script =
        "function runRenameAndSave() {\n" +
        "    var comp = app.project.activeItem;\n" +
        "    if (!comp || !(comp instanceof CompItem)) return '{\"ok\":false,\"error\":\"Open a composition first\"}';\n" +
        "    var sel = comp.selectedLayers;\n" +
        "    if (!sel || sel.length !== 1) return '{\"ok\":false,\"error\":\"Select exactly one layer\"}';\n" +
        "    var layer = sel[0];\n" +
        "    var targetEffect = getTargetEffectForSave();\n" +
        "    if (!targetEffect) return '{\"ok\":false,\"error\":\"Select an effect in Effect Controls\"}';\n" +
        "    var origName = targetEffect.name;\n" +
        "    targetEffect.name = '" + escapedName + "';\n" +
        "    var saveResult = toolkitSaveEffectPreset('" + encodeBridge(targetDir) + "');\n" +
        "    targetEffect.name = origName;\n" +
        "    return saveResult;\n" +
        "}\n" +
        "runRenameAndSave();";

    var confirmBtn = document.getElementById("btn-tk-save-preset-confirm");

    // Bounded bridge call (Req 11/12): the raw evalScript this replaced disabled
    // the confirm button and only re-enabled it from the host callback — if AE
    // hung or never called back, the modal's Save button stayed dead forever with
    // no message. ToolBridge owns the busy state, the 30 s timeout, sentinel
    // classification ("EvalScript error." / "undefined" / empty), single-flight
    // and late-callback suppression, and guarantees the button is restored on
    // every terminal outcome.
    ToolBridge.call({
        key: "effects.save-preset",
        script: script,
        button: confirmBtn,
        onResult: function (result) {
            if (result.status !== "success") return; // timeout/host error already toasted

            var json = result.decoded;
            var parsed = {};
            try { parsed = JSON.parse(json); } catch (e) { parsed = { ok: false, error: json }; }

            if (!parsed.ok) {
                showToast(parsed.error || "Save failed", "error");
                return;
            }

            // Global URL decodeURIComponent decoding on localStorage originals key mapping
            if (parsed.file) {
                var rawBaseName = parsed.file.replace(/\.(ffx|cseffect)$/i, "");
                setStoredOriginalName(parsed.file, safeDecodeURI(rawBaseName));
            }

            showToast("Preset \"" + escapeHTML(customName) + "\" saved successfully", "success");

            FocusTrap.deactivate();
            if (modal) modal.classList.remove("open");

            // Strict Latency Compensation: 150ms timeout post-save before executing directory rescan
            setTimeout(function () {
                var grid = document.getElementById("tk-effects-grid");
                if (grid) {
                    var files = scanEffectsFolder();
                    savedEffectsCache = files;
                    renderCategorySystem(files);
                    renderEffectsGridOrEmpty(grid, filterEffects(files));
                }
            }, 150);
        }
    });
}

// ── Apply handler ─────────────────────────────────────────────────────
function handleEffectApply(btn) {
    if (!btn) return;
    var fullPath = btn.dataset.effectFile || "";
    if (!fullPath) {
        showToast("Cannot resolve preset path", "error");
        return;
    }

    fullPath = fullPath.replace(/\\/g, "/");
    var isCustom = /\.cseffect$/i.test(fullPath);
    var script = isCustom ?
        "toolkitApplyCustomEffect(\"" + encodeBridge(fullPath) + "\")" :
        "toolkitApplyEffectPreset(\"" + encodeBridge(fullPath) + "\")";

    ToolBridge.call({
        key: "effects.apply",
        script: script,
        button: btn,
        timeoutMs: 15000,
        onResult: function (result) {
            if (result.status !== "success") return; // timeout/host error already toasted
            var json = result.decoded;
            var parsed = {};
            try { parsed = JSON.parse(json); } catch (e) { parsed = { ok: false, error: json }; }

            if (parsed.ok) {
                var displayName = (btn.dataset.effectName || "Effect").replace(/\.(ffx|cseffect)$/i, "");
                showToast("Applied \"" + escapeHTML(displayName) + "\"", "success");
            } else {
                showToast(parsed.error || "Apply failed", "error");
            }
        }
    });
}

// ── Favorite toggle ───────────────────────────────────────────────────
function handleEffectFavorite(btn) {
    if (!btn) return;
    var fileName = btn.dataset.effectFile || "";
    if (!fileName) return;
    favoriteEffects[fileName] = !favoriteEffects[fileName];
    saveFavoriteEffects();

    // Instantly re-sort the local data array itself
    if (savedEffectsCache) {
        savedEffectsCache.sort(function (a, b) {
            var aFav = !!favoriteEffects[a.file];
            var bFav = !!favoriteEffects[b.file];
            if (aFav && !bFav) return -1;
            if (!aFav && bFav) return 1;
            return a.order - b.order;
        });
    }

    // Instantly re-sort the grid and bubble favorites to the top-left beginning slot
    var grid = document.getElementById("tk-effects-grid");
    if (grid) {
        renderCategorySystem(savedEffectsCache);
        renderEffectsGridOrEmpty(grid, filterEffects(savedEffectsCache));
    }
}

// ── Persistent originalName Mapping Database (localStorage) ───────────
function getStoredOriginalNames() {
    try {
        var stored = localStorage.getItem("tk_effects_original_names");
        return stored ? JSON.parse(stored) : {};
    } catch (e) {
        return {};
    }
}

function saveStoredOriginalNames(map) {
    try {
        localStorage.setItem("tk_effects_original_names", JSON.stringify(map));
    } catch (e) { }
}

function setStoredOriginalName(fileName, originalName) {
    var map = getStoredOriginalNames();
    map[fileName] = originalName;
    saveStoredOriginalNames(map);
}

// decodeURIComponent throws a URIError on strings containing a stray "%"
// (e.g. "50% Glow.ffx"). Preset/file names are arbitrary on disk, so guard it.
function safeDecodeURI(str) {
    if (!str) return "";
    try {
        return decodeURIComponent(str);
    } catch (e) {
        return "" + str;
    }
}

var currentEffectsCategory = "ALL"; // Preset category filter state ("ALL", "FAVORITES", or custom folder name)
var isBulkDeleteModeActive = false;
var selectedPresetsForDeletion = [];

function renderCategorySystem(files) {
    var badge = document.getElementById("tk-category-badge");
    var listContainer = document.getElementById("tk-dropdown-list");
    if (!listContainer) return;

    listContainer.innerHTML = "";

    // Calculate categories & count presets in each
    var counts = { "ALL": 0, "FAVORITES": 0 };
    var customCats = [];

    for (var i = 0; i < files.length; i++) {
        var f = files[i];
        counts["ALL"]++;

        if (favoriteEffects[f.file]) {
            counts["FAVORITES"]++;
        }

        var cat = f.category || "GENERAL";
        if (!counts[cat]) {
            counts[cat] = 0;
            customCats.push(cat);
        }
        counts[cat]++;
    }

    customCats.sort();

    // Update badge count for custom folders
    if (badge) {
        badge.textContent = "+" + customCats.length;
    }

    // Add rows to custom dropdown
    for (var cIdx = 0; cIdx < customCats.length; cIdx++) {
        (function (cat) {
            var row = document.createElement("div");
            row.className = "category-row" + (currentEffectsCategory === cat ? " active" : "");

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
                selectEffectsCategory(cat);
                var dropdown = document.getElementById("tk-dropdown-menu");
                if (dropdown) dropdown.classList.remove("open");
            });

            listContainer.appendChild(row);
        })(customCats[cIdx]);
    }

    // Update static tab indicators
    var btnAll = document.getElementById("btn-tk-cat-all");
    var btnFav = document.getElementById("btn-tk-cat-fav");
    if (btnAll) btnAll.className = "category-tab" + (currentEffectsCategory === "ALL" ? " active" : "");
    if (btnFav) btnFav.className = "category-tab" + (currentEffectsCategory === "FAVORITES" ? " active" : "");
}

function selectEffectsCategory(category) {
    currentEffectsCategory = category;
    var grid = document.getElementById("tk-effects-grid");
    if (grid) {
        renderEffectsGridOrEmpty(grid, filterEffects(savedEffectsCache));
    }
    renderCategorySystem(savedEffectsCache);
}

function handleBulkImport() {
    var importBtn = document.getElementById("btn-tk-bulk-import");
    if (!importBtn || importBtn.disabled) return;

    importBtn.disabled = true;

    var script =
        "function runImport() {\n" +
        "    var files = File.openDialog('Import File', 'All Acceptable Files (*.ffx):*.ffx;*.cseffect;All Files:*.*', true);\n" +
        "    if (!files) return 'CANCEL';\n" +
        "    var paths = [];\n" +
        "    if (files instanceof Array) {\n" +
        "        for (var i = 0; i < files.length; i++) { paths.push(files[i].fsName); }\n" +
        "    } else {\n" +
        "        paths.push(files.fsName);\n" +
        "    }\n" +
        "    return paths.join('|');\n" +
        "}\n" +
        "runImport();";

    csInterface.evalScript(script, function (res) {
        importBtn.disabled = false;
        if (!res || res === "CANCEL" || res === "EvalScript error." || res === "undefined") {
            return;
        }

        var selectedPaths = res.split("|");
        if (!selectedPaths.length) return;

        var activeDir = getActiveEffectsDir();
        if (!activeDir || !resolveNodeModules()) {
            showToast("Workspace path not ready", "error");
            return;
        }

        // Separate directories vs files
        var dirPaths = [];
        var filePaths = [];
        for (var pi = 0; pi < selectedPaths.length; pi++) {
            var rawP = selectedPaths[pi].replace(/\\/g, "/");
            try {
                var st = nodeFs.statSync(rawP);
                if (st.isDirectory()) {
                    dirPaths.push(rawP);
                } else {
                    filePaths.push(rawP);
                }
            } catch (e) {
                filePaths.push(rawP);
            }
        }

        // If directory/folder was selected, import all .ffx presets within and create category
        if (dirPaths.length > 0) {
            for (var di = 0; di < dirPaths.length; di++) {
                _importPresetsFromFolder(dirPaths[di], activeDir);
            }
            if (filePaths.length === 0) return;
        }

        // Enforce strict preset restriction: ONLY .ffx (or .cseffect) allowed.
        // Disallow media/footage files (.mp4, .mov, .png, .jpg, .psd, .aep, .wav, etc.)
        var validPresetPaths = [];
        var rejectedCount = 0;
        for (var fi = 0; fi < filePaths.length; fi++) {
            var fn = filePaths[fi].substring(filePaths[fi].lastIndexOf("/") + 1);
            if (/\.(ffx|cseffect)$/i.test(fn)) {
                validPresetPaths.push(filePaths[fi]);
            } else {
                rejectedCount++;
            }
        }

        if (validPresetPaths.length === 0) {
            if (dirPaths.length === 0) {
                if (rejectedCount > 0) {
                    showToast("Only .ffx presets are supported for FX import", "error");
                } else {
                    showToast("No valid presets selected", "error");
                }
            }
            return;
        }

        filePaths = validPresetPaths;

        // If multiple files are imported from a custom folder (e.g. 10 shakes from folder "Shake")
        var targetCategory = null;
        if (filePaths.length > 1) {
            var firstP = filePaths[0];
            var firstDir = firstP.substring(0, firstP.lastIndexOf("/"));
            var parentName = firstDir.substring(firstDir.lastIndexOf("/") + 1);
            var isGeneric = !parentName || /^(desktop|documents|downloads|temp|tmp|media|assets)$/i.test(parentName);
            if (!isGeneric) {
                targetCategory = parentName.toUpperCase();
            }
        }

        var importedCount = 0;
        for (var idx = 0; idx < filePaths.length; idx++) {
            var srcPath = filePaths[idx];
            var filename = srcPath.substring(srcPath.lastIndexOf("/") + 1);

            var destCatDir = activeDir;
            if (targetCategory) {
                destCatDir = activeDir.replace(/\/+$/, "") + "/" + targetCategory;
            } else if (currentEffectsCategory && currentEffectsCategory !== "ALL" && currentEffectsCategory !== "FAVORITES") {
                destCatDir = activeDir.replace(/\/+$/, "") + "/" + currentEffectsCategory.toUpperCase();
            }

            try {
                if (!nodeFs.existsSync(destCatDir)) {
                    nodeFs.mkdirSync(destCatDir, { recursive: true });
                }
                var destPath = destCatDir + "/" + filename;
                if (nodeFs.existsSync(destPath)) {
                    var base = filename.replace(/\.(ffx|cseffect)$/i, "");
                    var ext = filename.substring(filename.lastIndexOf("."));
                    var attempt = 2;
                    while (nodeFs.existsSync(destCatDir + "/" + base + " (" + attempt + ")" + ext)) {
                        attempt++;
                    }
                    destPath = destCatDir + "/" + base + " (" + attempt + ")" + ext;
                }
                nodeFs.copyFileSync(srcPath, destPath);

                var baseName = filename.replace(/\.(ffx|cseffect)$/i, "");
                setStoredOriginalName(filename, safeDecodeURI(baseName));
                importedCount++;
            } catch (err) {
                console.error("[Effects] Failed to copy file:", filename, err.message);
            }
        }

        if (importedCount > 0) {
            if (targetCategory) {
                showToast("Imported " + importedCount + " presets into \"" + escapeHTML(targetCategory) + "\"", "success");
            } else if (rejectedCount > 0) {
                showToast("Imported " + importedCount + " preset" + (importedCount > 1 ? "s" : "") + " (" + rejectedCount + " non-preset skipped)", "warning");
            } else {
                showToast("Successfully imported " + importedCount + " preset" + (importedCount > 1 ? "s" : "") + "!", "success");
            }

            var grid = document.getElementById("tk-effects-grid");
            if (grid) {
                var files = scanEffectsFolder();
                savedEffectsCache = files;
                renderCategorySystem(files);
                if (targetCategory) {
                    selectEffectsCategory(targetCategory);
                } else {
                    renderEffectsGridOrEmpty(grid, filterEffects(files));
                }
            }
        } else if (dirPaths.length === 0) {
            showToast("No presets could be imported", "error");
        }
    });
}

function _importPresetsFromFolder(folderPath, activeDir) {
    var folderName = folderPath.substring(folderPath.lastIndexOf("/") + 1);
    if (!folderName) {
        showToast("Invalid folder selected", "error");
        return;
    }
    var categoryName = folderName.toUpperCase();
    var destCatDir = activeDir.replace(/\/+$/, "") + "/" + categoryName;

    var presetFiles = [];
    function collectPresets(dir) {
        try {
            var entries = nodeFs.readdirSync(dir);
            for (var i = 0; i < entries.length; i++) {
                var fp = dir.replace(/\/+$/, "") + "/" + entries[i];
                var stat = nodeFs.statSync(fp);
                if (stat.isDirectory()) {
                    collectPresets(fp);
                } else if (/\.(ffx|cseffect)$/i.test(entries[i])) {
                    presetFiles.push({ path: fp, name: entries[i] });
                }
            }
        } catch (e) {
            console.warn("[Effects] Error scanning folder:", dir, e.message);
        }
    }
    collectPresets(folderPath);

    if (presetFiles.length === 0) {
        showToast("No .ffx or .cseffect presets found in \"" + escapeHTML(folderName) + "\"", "error");
        return;
    }

    try {
        if (!nodeFs.existsSync(destCatDir)) {
            nodeFs.mkdirSync(destCatDir, { recursive: true });
        }
    } catch (err) {
        showToast("Failed to create category folder", "error");
        return;
    }

    var importedCount = 0;
    for (var fi = 0; fi < presetFiles.length; fi++) {
        try {
            var destPath = destCatDir + "/" + presetFiles[fi].name;
            if (nodeFs.existsSync(destPath)) {
                var base = presetFiles[fi].name.replace(/\.(ffx|cseffect)$/i, "");
                var ext = presetFiles[fi].name.substring(presetFiles[fi].name.lastIndexOf("."));
                var attempt = 2;
                while (nodeFs.existsSync(destCatDir + "/" + base + " (" + attempt + ")" + ext)) {
                    attempt++;
                }
                destPath = destCatDir + "/" + base + " (" + attempt + ")" + ext;
            }
            nodeFs.copyFileSync(presetFiles[fi].path, destPath);

            var baseName = presetFiles[fi].name.replace(/\.(ffx|cseffect)$/i, "");
            setStoredOriginalName(presetFiles[fi].name, safeDecodeURI(baseName));
            importedCount++;
        } catch (err) {
            console.error("[Effects] Failed to copy preset:", presetFiles[fi].name, err.message);
        }
    }

    if (importedCount > 0) {
        showToast("Imported " + importedCount + " presets into \"" + escapeHTML(folderName) + "\"", "success");

        var grid = document.getElementById("tk-effects-grid");
        if (grid) {
            var files = scanEffectsFolder();
            savedEffectsCache = files;
            renderCategorySystem(files);
            selectEffectsCategory(categoryName);
        }
    } else {
        showToast("No presets could be imported", "error");
    }
}

// ── Presets Rename and Delete Modals State ────────────────────────────
var activeRenamePresetBtn = null;
var activeDeletePresetBtn = null;

function openPresetRenameModal(btn) {
    if (!btn) return;
    activeRenamePresetBtn = btn;
    var oldName = btn.dataset.effectName || "";
    var fullPath = btn.dataset.effectFile || "";
    var fileName = fullPath.substring(fullPath.lastIndexOf("/") + 1) || oldName;

    var origMap = getStoredOriginalNames();
    var originalName = origMap[fileName] || btn.dataset.effectOriginalName || btn.getAttribute("data-effect-original-name") || oldName;

    var input = document.getElementById("tk-effects-rename-input");
    if (input) {
        input.value = oldName;
        setTimeout(function () { input.focus(); input.select(); }, 50);
    }

    var sugWrap = document.getElementById("tk-effects-rename-suggestions");
    if (sugWrap) {
        sugWrap.innerHTML = ""; // Clear existing chips
        var suggestions = generateNameSuggestions(originalName);
        if (suggestions && suggestions.length > 0) {
            for (var sIdx = 0; sIdx < suggestions.length; sIdx++) {
                (function (sugText) {
                    var chip = document.createElement("button");
                    chip.type = "button";
                    chip.className = "modal-sug-chip";
                    chip.textContent = sugText;

                    chip.addEventListener("click", function (e) {
                        e.stopPropagation();
                        e.preventDefault();
                        if (input) {
                            input.value = sugText;
                            input.focus();
                            input.select();
                        }
                    });

                    sugWrap.appendChild(chip);
                })(suggestions[sIdx]);
            }
        }
    }

    var modal = document.getElementById("tk-effects-rename-modal");
    if (modal) {
        modal.classList.add("open");
        FocusTrap.activate(modal);
    }
}

function closePresetRenameModal() {
    FocusTrap.deactivate();
    var modal = document.getElementById("tk-effects-rename-modal");
    if (modal) {
        modal.classList.remove("open");
    }
    activeRenamePresetBtn = null;
}

function confirmPresetRename() {
    var btn = activeRenamePresetBtn;
    if (!btn || !resolveNodeModules()) return;

    var input = document.getElementById("tk-effects-rename-input");
    if (!input) return;

    var newNameInput = input.value;
    var oldName = btn.dataset.effectName || "";
    var fullPath = btn.dataset.effectFile || "";

    var cleanName = newNameInput.trim().replace(/[\/\\:\*\?"<>\|]/g, "");
    if (!cleanName) {
        showToast("Invalid name", "error");
        return;
    }

    // Determine extension
    var ext = fullPath.match(/\.(ffx|cseffect)$/i);
    var extension = ext ? ext[0] : ".cseffect";
    var dirPath = fullPath.substring(0, fullPath.lastIndexOf("/"));
    var newFullPath = dirPath + "/" + cleanName + extension;

    if (newFullPath === fullPath) {
        closePresetRenameModal();
        return;
    }

    try {
        if (nodeFs.existsSync(newFullPath)) {
            showToast("A preset with this name already exists", "error");
            return;
        }

        effectsRenameLock = true;
        nodeFs.renameSync(fullPath, newFullPath);

        // Update persistent originalName map
        var oldFileName = fullPath.substring(fullPath.lastIndexOf("/") + 1);
        var newFileName = cleanName + extension;
        var cachedOrigName = oldFileName.replace(/\.(ffx|cseffect)$/i, "");

        if (savedEffectsCache) {
            for (var idxCache = 0; idxCache < savedEffectsCache.length; idxCache++) {
                if (savedEffectsCache[idxCache].path === fullPath) {
                    cachedOrigName = savedEffectsCache[idxCache].originalName || cachedOrigName;
                    break;
                }
            }
        }

        var origMap = getStoredOriginalNames();
        origMap[newFileName] = cachedOrigName;
        delete origMap[oldFileName];
        saveStoredOriginalNames(origMap);

        // Update favorite state if favorited
        if (favoriteEffects[oldFileName]) {
            favoriteEffects[newFileName] = true;
            delete favoriteEffects[oldFileName];
            saveFavoriteEffects();
        }

        showToast("Preset renamed successfully", "success");

        // Mutate in-place inside savedEffectsCache to lock position post-rename
        if (savedEffectsCache) {
            for (var idxCache = 0; idxCache < savedEffectsCache.length; idxCache++) {
                var cacheItem = savedEffectsCache[idxCache];
                if (cacheItem.path === fullPath) {
                    cacheItem.file = newFileName;
                    cacheItem.path = newFullPath;
                    cacheItem.displayName = cleanName; // Mutate displayName in global cache
                    break;
                }
            }
        }

        // Render directly with mutated cache
        var grid = document.getElementById("tk-effects-grid");
        if (grid) {
            renderEffectsGridOrEmpty(grid, filterEffects(savedEffectsCache));
        }

        // Update dataset of active button so further rename calls inside open modal are correct!
        btn.dataset.effectName = cleanName;
        btn.dataset.effectFile = newFullPath;

        // Also update the card's dataset!
        var card = btn.closest(".tk-effect-card");
        if (card) {
            card.dataset.effectName = cleanName;
            card.dataset.effectFile = newFullPath;
        }

        closePresetRenameModal();

        setTimeout(function () {
            effectsRenameLock = false;
        }, 300);

    } catch (e) {
        effectsRenameLock = false;
        showToast("Failed to rename file: " + e.message, "error");
    }
}

function openPresetDeleteModal(btn) {
    if (!btn) return;
    activeDeletePresetBtn = btn;
    var displayName = btn.dataset.effectName || "";
    var msgEl = document.getElementById("tk-effects-delete-msg");
    if (msgEl) {
        msgEl.textContent = 'Are you sure you want to delete "' + displayName + '" permanently?';
    }
    var modal = document.getElementById("tk-effects-delete-modal");
    if (modal) {
        modal.classList.add("open");
        FocusTrap.activate(modal);
    }
}

function closePresetDeleteModal() {
    FocusTrap.deactivate();
    var modal = document.getElementById("tk-effects-delete-modal");
    if (modal) {
        modal.classList.remove("open");
    }
    activeDeletePresetBtn = null;
}

function confirmPresetDelete() {
    var btn = activeDeletePresetBtn;
    if (!btn || !resolveNodeModules()) return;

    var fullPath = btn.dataset.effectFile || "";

    try {
        if (nodeFs.existsSync(fullPath)) {
            nodeFs.unlinkSync(fullPath);
        }

        // Remove from favorites
        var fileName = fullPath.substring(fullPath.lastIndexOf("/") + 1);
        if (favoriteEffects[fileName]) {
            delete favoriteEffects[fileName];
            saveFavoriteEffects();
        }

        showToast("Preset deleted", "success");

        // Rescan and render
        var grid = document.getElementById("tk-effects-grid");
        if (grid) {
            var files = scanEffectsFolder();
            savedEffectsCache = files;
            renderCategorySystem(files);
            renderEffectsGridOrEmpty(grid, filterEffects(files));
        }

        closePresetDeleteModal();

    } catch (e) {
        showToast("Failed to delete file: " + e.message, "error");
    }
}

// ── Rename handler ────────────────────────────────────────────────────
function handleEffectRename(btn) {
    if (!btn) return;
    var card = btn.closest(".tk-effect-card");
    if (card) {
        // Set selection state on left click Pencil too, keeping keyboard deletion in sync!
        var grid = document.getElementById("tk-effects-grid");
        if (grid) {
            var allCards = grid.querySelectorAll(".tk-effect-card");
            for (var i = 0; i < allCards.length; i++) {
                allCards[i].classList.remove("is-selected");
            }
        }
        card.classList.add("is-selected");
        openPresetRenameModal(btn);
    }
}

// ── Delete handler ────────────────────────────────────────────────────
function handleEffectDelete(btn) {
    openPresetDeleteModal(btn);
}

// ── Smart Short-Name Suggestion Matrix ────────────────────────────────
function generateNameSuggestions(name) {
    if (!name) return [];
    var clean = name.trim().replace(/\.(ffx|cseffect)$/i, "");
    var suggestions = [];

    // Split by spaces, underscores, hyphens, or dots
    var words = clean.split(/[\s_\-\.]+/);
    var mainWord = words[words.length - 1] || "";

    // 1. Initials (e.g., CC Vignette -> CCV, Motion Tile -> MT)
    if (words.length > 1) {
        var initials = "";
        for (var i = 0; i < words.length; i++) {
            if (words[i]) initials += words[i].charAt(0).toUpperCase();
        }
        if (initials && initials.length > 1) {
            suggestions.push(initials);
        }
    }

    // 2. Last word or main word (e.g., CC Vignette -> Vignette)
    if (mainWord && mainWord.length > 2) {
        suggestions.push(mainWord);
    }

    // 3. Prefix + Abbreviation (e.g., CC Vignette -> CC Vig)
    if (words.length > 1) {
        var prefixAbbr = words[0];
        var restAbbr = mainWord.substring(0, 3);
        if (prefixAbbr && restAbbr) {
            suggestions.push(prefixAbbr + " " + restAbbr);
        }
    }

    // 4. Vowel-stripped abbreviation of main word (e.g., Vignette -> Vgnt, Tile -> Tl)
    if (mainWord && mainWord.length > 2) {
        var stripped = mainWord.replace(/[aeiou]/gi, "");
        if (stripped && stripped.length > 1 && stripped.toLowerCase() !== mainWord.toLowerCase()) {
            suggestions.push(stripped);
        }
    }

    // 5. First 3 letters of main word uppercase (e.g., Vignette -> VIG)
    if (mainWord && mainWord.length >= 3) {
        suggestions.push(mainWord.substring(0, 3).toUpperCase());
    }

    // 6. Progressive slicing: First 4 characters
    if (mainWord && mainWord.length >= 4) {
        suggestions.push(mainWord.substring(0, 4));
    }

    // 7. Progressive slicing: First 5 characters
    if (mainWord && mainWord.length >= 5) {
        suggestions.push(mainWord.substring(0, 5));
    }

    // Final fallback validation & deduplication
    var result = [];
    var seen = {};
    seen[clean.toLowerCase()] = true;
    for (var j = 0; j < suggestions.length; j++) {
        var sug = suggestions[j].trim();
        var lowerSug = sug.toLowerCase();
        if (sug && !seen[lowerSug] && sug.length > 1) {
            seen[lowerSug] = true;
            result.push(sug);
        }
    }

    // Populate up to exactly 5 distinct micro chip options
    if (result.length < 5 && mainWord.length > 2) {
        var defaultAbbr = mainWord.substring(0, Math.min(mainWord.length, 3)).toUpperCase();
        if (!seen[defaultAbbr.toLowerCase()]) {
            seen[defaultAbbr.toLowerCase()] = true;
            result.push(defaultAbbr);
        }
    }

    // Add progressive uppercase slices if still under 5
    var sliceLengths = [3, 4, 2, 5];
    for (var k = 0; k < sliceLengths.length && result.length < 5; k++) {
        var len = sliceLengths[k];
        if (mainWord.length >= len) {
            var pAbbr = mainWord.substring(0, len).toUpperCase();
            if (!seen[pAbbr.toLowerCase()]) {
                seen[pAbbr.toLowerCase()] = true;
                result.push(pAbbr);
            }
        }
    }

    // Force the full, un-abbreviated original name as the very first chip (Chip Index 0)
    var finalResult = [clean];
    var seenResult = {};
    seenResult[clean.toLowerCase()] = true;

    for (var rIdx = 0; rIdx < result.length && finalResult.length < 5; rIdx++) {
        var resSug = result[rIdx];
        var lowerResSug = resSug.toLowerCase();
        if (!seenResult[lowerResSug]) {
            seenResult[lowerResSug] = true;
            finalResult.push(resSug);
        }
    }

    return finalResult.slice(0, 5);
}

// ── Double-Click / Right-Click Inline Renaming ─────────────────────────
function startInlineRename(card) {
    if (!card) return;
    var nameEl = card.querySelector(".effect-name");
    if (!nameEl || nameEl.querySelector(".inline-rename-input")) return;

    var oldName = card.dataset.effectName || "";
    var fullPath = card.dataset.effectFile || "";

    // Temporarily unlock overflow to allow the input box to be visible
    card.style.overflow = "visible";
    nameEl.style.overflow = "visible";

    var input = document.createElement("input");
    input.type = "text";
    input.className = "inline-rename-input";
    input.value = oldName;

    input.addEventListener("click", function (e) {
        e.stopPropagation();
    });
    input.addEventListener("dblclick", function (e) {
        e.stopPropagation();
    });

    var isSaving = false;
    function saveInline() {
        if (isSaving) return;
        isSaving = true;

        var newNameInput = input.value;
        var cleanName = newNameInput.trim().replace(/[\/\\:\*\?"<>\|]/g, "");

        // Restore default container overflow
        card.style.overflow = "";
        nameEl.style.overflow = "";

        if (!cleanName) {
            showToast("Invalid name", "error");
            cancelInline();
            return;
        }

        if (cleanName === oldName) {
            cancelInline();
            return;
        }

        if (!resolveNodeModules()) {
            cancelInline();
            return;
        }

        var ext = fullPath.match(/\.(ffx|cseffect)$/i);
        var extension = ext ? ext[0] : ".cseffect";
        var dirPath = fullPath.substring(0, fullPath.lastIndexOf("/"));
        var newFullPath = dirPath + "/" + cleanName + extension;

        try {
            if (nodeFs.existsSync(newFullPath)) {
                showToast("A preset with this name already exists", "error");
                cancelInline();
                return;
            }

            effectsRenameLock = true;
            nodeFs.renameSync(fullPath, newFullPath);

            // Update persistent originalName map
            var oldFileName = fullPath.substring(fullPath.lastIndexOf("/") + 1);
            var newFileName = cleanName + extension;
            var cachedOrigName = oldFileName.replace(/\.(ffx|cseffect)$/i, "");

            if (savedEffectsCache) {
                for (var idxCache = 0; idxCache < savedEffectsCache.length; idxCache++) {
                    if (savedEffectsCache[idxCache].path === fullPath) {
                        cachedOrigName = savedEffectsCache[idxCache].originalName || cachedOrigName;
                        break;
                    }
                }
            }

            var origMap = getStoredOriginalNames();
            origMap[newFileName] = cachedOrigName;
            delete origMap[oldFileName];
            saveStoredOriginalNames(origMap);

            if (favoriteEffects[oldFileName]) {
                favoriteEffects[newFileName] = true;
                delete favoriteEffects[oldFileName];
                saveFavoriteEffects();
            }

            showToast("Preset renamed", "success");

            if (savedEffectsCache) {
                for (var idxCache = 0; idxCache < savedEffectsCache.length; idxCache++) {
                    var cacheItem = savedEffectsCache[idxCache];
                    if (cacheItem.path === fullPath) {
                        cacheItem.file = newFileName;
                        cacheItem.path = newFullPath;
                        cacheItem.displayName = cleanName; // Mutate displayName in global cache
                        break;
                    }
                }
            }

            var grid = document.getElementById("tk-effects-grid");
            if (grid) {
                renderEffectsGridOrEmpty(grid, filterEffects(savedEffectsCache));
            }

            setTimeout(function () {
                effectsRenameLock = false;
            }, 300);

        } catch (err) {
            effectsRenameLock = false;
            showToast("Rename failed: " + err.message, "error");
            cancelInline();
        }
    }

    function cancelInline() {
        card.style.overflow = "";
        nameEl.style.overflow = "";
        nameEl.innerHTML = escapeHTML(oldName);
    }

    input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
            e.preventDefault();
            saveInline();
        } else if (e.key === "Escape") {
            e.preventDefault();
            cancelInline();
        }
    });

    input.addEventListener("blur", function () {
        setTimeout(function () {
            saveInline();
        }, 120);
    });

    nameEl.innerHTML = "";
    nameEl.appendChild(input);
    input.focus();
    input.select();
}

// ── In-Memory Zero-Latency Filtering & Sorting (Starred pinned to top) ──
function filterEffects(files) {
    if (!files) return [];

    var list = [];
    for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var fileName = (typeof f === "string") ? f : f.file;
        var category = (typeof f === "object" && f.category) ? f.category : "GENERAL";

        // Category Filter
        if (currentEffectsCategory === "FAVORITES") {
            if (!favoriteEffects[fileName]) continue;
        } else if (currentEffectsCategory !== "ALL") {
            if (category !== currentEffectsCategory) continue;
        }

        // Search query filter
        if (effectsSearchQuery) {
            var q = effectsSearchQuery.toLowerCase();
            var dispName = (typeof f === "object" && f.displayName) ? f.displayName : fileName.replace(/\.(ffx|cseffect)$/i, "");
            var origName = (typeof f === "object" && f.originalName) ? f.originalName : dispName;
            if (dispName.toLowerCase().indexOf(q) === -1 && origName.toLowerCase().indexOf(q) === -1) {
                continue;
            }
        }

        list.push(f);
    }

    // Sort so that favorites are placed at the absolute beginning, preceding standard presets
    list.sort(function (a, b) {
        var aName = (typeof a === "string") ? a : a.file;
        var bName = (typeof b === "string") ? b : b.file;

        var aFav = !!favoriteEffects[aName];
        var bFav = !!favoriteEffects[bName];

        if (aFav && !bFav) return -1;
        if (!aFav && bFav) return 1;

        var aOrder = (a && typeof a === "object" && typeof a.order === "number") ? a.order : 0;
        var bOrder = (b && typeof b === "object" && typeof b.order === "number") ? b.order : 0;
        return aOrder - bOrder;
    });

    return list;
}

// ── Grid bootstrap (called from switchToolkitSubSection + window focus) ──
// `force` bypasses the freshness gate. Callers that change what would be
// scanned (effects root changed in settings) must pass true.
function loadSavedEffects(force) {
    var grid = document.getElementById("tk-effects-grid");
    if (!grid) {
        console.warn("[Effects] #tk-effects-grid not in DOM — skipping render");
        return;
    }

    // Focus/sub-tab re-entry within the TTL skips the whole reload (bridge
    // ensureFolder roundtrip, watcher teardown, recursive sync scan, category
    // + grid re-render). Correctness: every real scanEffectsFolder() call
    // restamps freshness, mutations rescan immediately, fs.watch (when
    // available) pushes disk changes, and a native-dialog save flow keeps
    // focus away longer than the TTL, so the returning focus still rescans.
    // TTL=0 restores always-rescan behavior.
    if (!force) {
        var ttl = Settings.get("performance.effectsScanTtlMs");
        if (typeof ttl !== "number" || isNaN(ttl)) ttl = 4000;
        if (ttl > 0 &&
            effectsScanFreshness.at > 0 &&
            (Date.now() - effectsScanFreshness.at) < ttl &&
            effectsScanFreshness.key === getActiveEffectsDir() + "\n" + getLegacyEffectsDir()) {
            return;
        }
    }

    // Setup filter input and tab listeners (only once, on boot)
    setupEffectsControls();

    var activeDir = getActiveEffectsDir();
    if (activeDir) {
        EFFECTS_DIR = activeDir;
        // Secure path existence via host before scan and watch
        var folderSettled = false;
        var folderTimer = setTimeout(function () {
            if (!folderSettled) {
                folderSettled = true;
                startFolderWatch();
                var files = scanEffectsFolder();
                savedEffectsCache = files;
                renderCategorySystem(files);
                renderEffectsGridOrEmpty(grid, filterEffects(files));
            }
        }, 3000);
        csInterface.evalScript('ensureFolder("' + encodeBridge(activeDir) + '")', function () {
            if (folderSettled) return;
            folderSettled = true;
            clearTimeout(folderTimer);
            startFolderWatch();
            var files = scanEffectsFolder();
            savedEffectsCache = files;
            renderCategorySystem(files);
            renderEffectsGridOrEmpty(grid, filterEffects(files));
        });
    } else {
        var files = scanEffectsFolder();
        savedEffectsCache = files;
        renderCategorySystem(files);
        renderEffectsGridOrEmpty(grid, filterEffects(files));
    }
}

// ── Setup Controls and Listeners ──────────────────────────────────────
function setupEffectsControls() {
    var menuBtn = document.getElementById("tk-menu-toggle-btn");
    var menuDropdown = document.getElementById("tk-dropdown-menu");
    if (menuBtn && menuDropdown) {
        var newMenuBtn = menuBtn.cloneNode(true);
        menuBtn.parentNode.replaceChild(newMenuBtn, menuBtn);

        newMenuBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            e.preventDefault();
            menuDropdown.classList.toggle("open");
        });

        // Register the document-level outside-click closer only ONCE. Earlier this
        // ran on every loadSavedEffects() (boot, reconnect, browse...), leaking a
        // new listener each time. Look elements up live so it stays correct after
        // the menu button is re-cloned on later calls.
        if (!effectsOutsideClickWired) {
            effectsOutsideClickWired = true;
            document.addEventListener("click", function (e) {
                var dd = document.getElementById("tk-dropdown-menu");
                var mb = document.getElementById("tk-menu-toggle-btn");
                if (dd && !dd.contains(e.target) && (!mb || !mb.contains(e.target))) {
                    dd.classList.remove("open");
                }
            });
        }
    }

    var tabAll = document.getElementById("btn-tk-cat-all");
    if (tabAll) {
        var newTabAll = tabAll.cloneNode(true);
        tabAll.parentNode.replaceChild(newTabAll, tabAll);
        newTabAll.addEventListener("click", function (e) {
            e.stopPropagation();
            e.preventDefault();
            selectEffectsCategory("ALL");
        });
    }

    var tabFav = document.getElementById("btn-tk-cat-fav");
    if (tabFav) {
        var newTabFav = tabFav.cloneNode(true);
        tabFav.parentNode.replaceChild(newTabFav, tabFav);
        newTabFav.addEventListener("click", function (e) {
            e.stopPropagation();
            e.preventDefault();
            selectEffectsCategory("FAVORITES");
        });
    }
}

// ── Render helpers ────────────────────────────────────────────────────
function renderEffectsGridOrEmpty(grid, files) {
    if (!files || files.length === 0) {
        renderEffectsEmptyState(grid);
    } else {
        renderEffectsGrid(grid, files);
    }
}

function renderEffectsEmptyState(grid) {
    // Shared empty-state pattern (base.css §2.2): container → icon → title → text.
    // Keeps the .tk-empty-state class so existing CSS/appearance is preserved.
    grid.innerHTML =
        '<div class="tk-empty-state cs-empty-state">' +
        '<span class="cs-empty-state__icon" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="M3 13l9 5 9-5"/></svg>' +
        '</span>' +
        '<span class="cs-empty-state__title">No Presets Saved</span>' +
        '<small class="cs-empty-state__text">Select an effect in AE and click Save</small>' +
        '</div>';
}

function renderEffectsGrid(grid, files) {
    var html = "";
    for (var i = 0; i < files.length; i++) {
        var fileObj = files[i];
        var fileName = (typeof fileObj === "string") ? fileObj : fileObj.file;
        var filePath = (typeof fileObj === "string") ? "" : fileObj.path;

        var prettyName = (typeof fileObj === "object" && fileObj.displayName) ? fileObj.displayName : fileName.replace(/\.(ffx|cseffect)$/i, "");
        var origName = (typeof fileObj === "object" && fileObj.originalName) ? fileObj.originalName : prettyName;
        var safeName = escapeHTML(prettyName);
        var safeFile = escapeAttr(fileName);
        var isFav = !!favoriteEffects[fileName];
        var isCustom = /\.cseffect$/i.test(fileName);
        var badgeText = isCustom ? "JSON" : "FFX";

        // Resolve full absolute path mapping
        var fullPath = filePath;
        if (!fullPath && EFFECTS_DIR) {
            fullPath = EFFECTS_DIR.replace(/\/+$/, "") + "/" + fileName;
        }

        html +=
            '<div class="tk-effect-card' + (isFav ? ' is-fav' : '') + '"' +
            ' data-toolkit-action="effect-apply"' +
            ' data-effect-file="' + escapeAttr(fullPath) + '"' +
            ' data-effect-name="' + escapeAttr(prettyName) + '"' +
            ' data-effect-original-name="' + escapeAttr(origName) + '"' +
            ' data-tooltip="' + escapeAttr(origName) + '">' +

            // ── Favorite star (top-right corner) ───────────────────────
            '<span class="fav-star' + (isFav ? ' active' : '') + '"' +
            ' role="button" tabindex="0"' +
            ' data-toolkit-action="effect-favorite"' +
            ' data-effect-file="' + safeFile + '"' +
            ' aria-label="Favorite ' + safeName + '">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
            ' stroke-linecap="round" stroke-linejoin="round">' +
            '<polygon points="12 2 15 8.5 22 9.3 17 14.2 18.2 21.2 12 17.8 5.8 21.2 7 14.2 2 9.3 9 8.5 12 2" />' +
            '</svg></span>' +

            // ── Rename Pen (bottom-right corner, visible on hover) ────
            '<button class="action-btn rename-btn" data-toolkit-action="effect-rename"' +
            ' data-effect-file="' + escapeAttr(fullPath) + '"' +
            ' data-effect-name="' + escapeAttr(prettyName) + '"' +
            ' data-effect-original-name="' + escapeAttr(origName) + '"' +
            ' aria-label="Rename">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"' +
            ' stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />' +
            '<path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />' +
            '</svg></button>' +

            // ── Delete Trash (top-left corner, visible on hover) ──────
            '<button class="action-btn delete-btn" data-toolkit-action="effect-delete"' +
            ' data-effect-file="' + escapeAttr(fullPath) + '"' +
            ' data-effect-name="' + escapeAttr(prettyName) + '"' +
            ' aria-label="Delete">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"' +
            ' stroke-linecap="round" stroke-linejoin="round">' +
            '<polyline points="3 6 5 6 21 6" />' +
            '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />' +
            '<line x1="10" y1="11" x2="10" y2="17" />' +
            '<line x1="14" y1="11" x2="14" y2="17" />' +
            '</svg></button>' +

            // ── FFX chip badge (text pill) ─────────────────────────────
            '<span class="ffx-icon">' + badgeText + '</span>' +

            // ── Effect name label ──────────────────────────────────────
            '<span class="effect-name">' + safeName + '</span>' +
            '</div>';
    }
    grid.innerHTML = html;
}

// ── Settings reactivity ───────────────────────────────────────────────
var effectsSettingsUnsubscribe = Settings.onChange("performance.liveFolderWatch", function (enabled) {
    if (enabled) {
        startFolderWatch();
    } else {
        stopFolderWatch();
    }
});
if (typeof FeatureFlags !== "undefined" && FeatureFlags.flags.lifecycleV1 &&
    typeof AppLifecycle !== "undefined") AppLifecycle.subscribe(effectsSettingsUnsubscribe);
