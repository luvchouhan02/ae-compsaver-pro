// ============================================================
// toolkit/toolkit.js - workflow toolkit navigation + action dispatch
// ------------------------------------------------------------
// initToolkitNav (binds toolkit buttons) + runToolkitAction (dispatches
// anchor/align/sequence/precompose/etc. to JSX). Depends on globals:
// bindClick, switchMainModule/switchToolkitSubSection (ui/header.js),
// csInterface, encodeBridge/decodeBridge, showToast, DOM,
// updateActiveCompMonitor (ui/comp-monitor.js). init() calls initToolkitNav().
// Loaded before main.js.
// ============================================================

// Run fn once the named View_Fragment is mounted (Req 4.6, 4.11). Without the
// view loader (Jest VM harnesses, legacy markup) fn runs at once; with it, fn
// is queued while the fragment is pending and dropped if the fragment failed.
function toolkitWhenViewMounted(name, fn) {
    if (typeof CompSaverViews !== "undefined" && CompSaverViews && Array.isArray(CompSaverViews.MANIFEST) &&
        typeof CompSaverViews.whenMounted === "function") {
        CompSaverViews.whenMounted(name, function () { fn(); });
        return;
    }
    fn();
}

// Binds every [data-toolkit-action] control under root exactly once (the
// Shell from initToolkitNav, each View_Fragment root from the view loader's
// onMounted hook in main.js).
var _toolkitBoundControls = typeof WeakSet === "function" ? new WeakSet() : null;
function bindToolkitActionControls(root) {
    root = root || document;
    if (!root || typeof root.querySelectorAll !== "function") return 0;
    var btns = root.querySelectorAll("[data-toolkit-action]");
    var bound = 0;
    for (var i = 0; i < btns.length; i++) {
        if (_toolkitBoundControls) {
            if (_toolkitBoundControls.has(btns[i])) continue;
            _toolkitBoundControls.add(btns[i]);
        } else if (btns[i]._csToolkitBound) {
            continue;
        } else {
            btns[i]._csToolkitBound = true;
        }
        btns[i].addEventListener("click", function (e) {
            runToolkitAction(
                this.dataset.toolkitAction || "",
                this.dataset.mode || "",
                this,
                e
            );
        });
        bound++;
    }
    return bound;
}

function initToolkitNav() {
    bindClick("btn-main-toolkit", function () { switchMainModule(MODULES.TOOLKIT); });
    bindClick("btn-main-templates", function () { switchMainModule(MODULES.TEMPLATES); });

    bindClick("btn-tk-tools", function () { switchToolkitSubSection("tools"); });
    bindClick("btn-tk-effects", function () { switchToolkitSubSection("effects"); });
    bindClick("btn-tk-graph", function () { switchToolkitSubSection("graph"); });
    bindClick("btn-tk-text-anim", function () { switchToolkitSubSection("text-anim"); });

    bindToolkitActionControls(document);

    toolkitWhenViewMounted("tools", initToolkitToolsControls);
    toolkitWhenViewMounted("effects", initToolkitEffectsGrid);

    // Bounce settings modal (overlays fragment, mounted before init()).
    var btnBounceClose = document.getElementById("btn-bounce-settings-close");
    if (btnBounceClose) {
        btnBounceClose.addEventListener("click", function () {
            FocusTrap.deactivate();
            var modal = document.getElementById("bounce-settings-modal");
            if (modal) modal.classList.remove("open");
        });
    }
    var btnBounceSave = document.getElementById("btn-bounce-settings-save");
    if (btnBounceSave) {
        btnBounceSave.addEventListener("click", function () {
            FocusTrap.deactivate();
            var modal = document.getElementById("bounce-settings-modal");
            if (modal) modal.classList.remove("open");
        });
    }
    var btnBounceReset = document.getElementById("btn-bounce-settings-reset");
    if (btnBounceReset) {
        btnBounceReset.addEventListener("click", function () {
            var f = document.getElementById("bounce-freq");
            var a = document.getElementById("bounce-amp");
            var d = document.getElementById("bounce-decay");
            if (f) f.value = "3";
            if (a) a.value = "40";
            if (d) d.value = "5";
        });
    }

    // Backdrop click to dismiss bounce-settings modal
    var bounceModal = document.getElementById("bounce-settings-modal");
    if (bounceModal) {
        bounceModal.addEventListener("click", function (e) {
            if (e.target === bounceModal) {
                FocusTrap.deactivate();
                bounceModal.classList.remove("open");
            }
        });
    }

    // Global [Delete] / [Backspace] listener for active card deletion
    document.addEventListener("keydown", function (e) {
        if (e.key === "Delete" || e.key === "Backspace") {
            if (document.activeElement &&
                (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA" || document.activeElement.isContentEditable)) {
                return; // Abort if user is actively writing text
            }

            var grid = document.getElementById("tk-effects-grid");
            if (grid) {
                var selected = grid.querySelector(".tk-effect-card.is-selected");
                if (selected) {
                    var deleteBtn = selected.querySelector(".delete-btn");
                    if (deleteBtn) {
                        e.preventDefault();
                        e.stopPropagation();
                        openPresetDeleteModal(deleteBtn);
                    }
                }
            }
        }
    });

    toolkitWhenViewMounted("easing", function () {
        initFlowSystem();
        initFlowCompactObserver();
    });
}

// Workbench (tools fragment) id-bound controls: resize, bounce, crop.
function initToolkitToolsControls() {
    if (typeof CompSaverWorkbench !== "undefined") {
        CompSaverWorkbench.init(document.getElementById("toolkit-tools-view"));
        if (typeof CompSaverRouter !== "undefined") {
            CompSaverRouter.registerHooks("tools", {
                onRestore: function (state) { return CompSaverWorkbench.restore(state.subsection); },
                patch: function () { return CompSaverWorkbench.getRestorationPatch(); },
                fallback: "layout"
            });
        }
    }
    // Resize comp-tree: reads resolution + FPS dropdowns, dispatches "short|fps".
    var btnResize = document.getElementById("btn-resize-apply");
    if (btnResize) {
        btnResize.addEventListener("click", function () {
            var resEl = document.getElementById("resize-res");
            var fpsEl = document.getElementById("resize-fps");
            var res = resEl ? parseInt(resEl.value, 10) : 0;
            var fps = fpsEl ? parseFloat(fpsEl.value) : 0;
            if (!res || res < 1) { showToast("Select a resolution", "error"); return; }
            if (!fps || fps <= 0) { showToast("Select a frame rate", "error"); return; }
            runToolkitAction("resize", res + "|" + fps, this);
        });
    }

    // Bounce overshoot: reads Freq/Amp/Decay from settings, dispatches "freq|amp|decay".
    var btnBounce = document.getElementById("btn-bounce-apply");
    if (btnBounce) {
        btnBounce.addEventListener("click", function () {
            var freq = parseFloat((document.getElementById("bounce-freq") || {}).value) || 3;
            var amp = parseFloat((document.getElementById("bounce-amp") || {}).value) || 40;
            var decay = parseFloat((document.getElementById("bounce-decay") || {}).value) || 5;
            runToolkitAction("bounce", freq + "|" + amp + "|" + decay, this);
        });
    }
    var btnGear = document.getElementById("btn-bounce-gear");
    if (btnGear) {
        btnGear.addEventListener("click", function () {
            var modal = document.getElementById("bounce-settings-modal");
            if (modal) {
                modal.classList.add("open");
                FocusTrap.activate(modal, btnGear);
            }
        });
    }

    initToolkitCropControls();
}

// Delegated handler for dynamically-rendered effect cards (effects fragment).
function initToolkitEffectsGrid() {
    if (typeof OneFramers !== "undefined") OneFramers.init();
    var effectsGrid = document.getElementById("tk-effects-grid");
    if (effectsGrid) {
        effectsGrid.addEventListener("click", function (e) {
            // If bulk delete mode is active, intercept clicks on cards!
            if (isBulkDeleteModeActive) {
                var card = e.target.closest(".tk-effect-card");
                if (card) {
                    e.stopPropagation();
                    e.preventDefault();

                    var path = card.dataset.effectFile;
                    if (path) {
                        var idx = selectedPresetsForDeletion.indexOf(path);
                        if (idx > -1) {
                            selectedPresetsForDeletion.splice(idx, 1);
                            card.classList.remove("selected-for-delete");
                        } else {
                            selectedPresetsForDeletion.push(path);
                            card.classList.add("selected-for-delete");
                        }
                    }
                    var countSpan = document.getElementById("tk-delete-count");
                    var toggleBtn = document.getElementById("btn-tk-bulk-delete-toggle");
                    if (countSpan) {
                        countSpan.textContent = "(" + selectedPresetsForDeletion.length + ")";
                        if (selectedPresetsForDeletion.length > 0) {
                            countSpan.style.display = "inline-block";
                            if (toggleBtn) {
                                toggleBtn.style.color = "#f43f5e";
                                toggleBtn.style.borderColor = "#f43f5e";
                                toggleBtn.style.background = "rgba(244, 63, 94, 0.08)";
                            }
                        } else {
                            countSpan.style.display = "none";
                            if (toggleBtn) {
                                toggleBtn.style.color = "#ef4444";
                                toggleBtn.style.borderColor = "rgba(239, 68, 68, 0.4)";
                                toggleBtn.style.background = "rgba(239, 68, 68, 0.08)";
                            }
                            var confirmWrap = document.getElementById("tk-bulk-delete-confirm-wrap");
                            if (confirmWrap) confirmWrap.style.display = "none";
                        }
                    }
                }
                return;
            }

            // Absolute Event Isolation: Intercept utility micro action controls first
            var favStar = e.target.closest(".fav-star");
            var renameBtn = e.target.closest(".rename-btn");
            var deleteBtn = e.target.closest(".delete-btn");

            if (favStar || renameBtn || deleteBtn) {
                e.stopPropagation();
                e.preventDefault();

                var targetBtn = favStar || renameBtn || deleteBtn;
                var action = targetBtn.dataset.toolkitAction;
                runToolkitAction(action, targetBtn.dataset.mode || "", targetBtn);
                return;
            }

            // Otherwise, handle the main card click (Apply effect)
            var card = e.target.closest(".tk-effect-card");
            if (card) {
                e.stopPropagation();
                e.preventDefault();

                // Mark visually as the active/focused card
                var allCards = effectsGrid.querySelectorAll(".tk-effect-card");
                for (var i = 0; i < allCards.length; i++) {
                    allCards[i].classList.remove("is-selected");
                }
                card.classList.add("is-selected");

                var action = card.dataset.toolkitAction;
                runToolkitAction(action, card.dataset.mode || "", card);
            }
        });

        effectsGrid.addEventListener("contextmenu", function (e) {
            var card = e.target.closest(".tk-effect-card");
            if (card) {
                e.preventDefault();
                e.stopPropagation();

                // Mark visually as the active/focused card
                var allCards = effectsGrid.querySelectorAll(".tk-effect-card");
                for (var i = 0; i < allCards.length; i++) {
                    allCards[i].classList.remove("is-selected");
                }
                card.classList.add("is-selected");

                startInlineRename(card);
            }
        });
    }
}

// Crop Precomposition binding (tools fragment; the warning modal lives in overlays).
function initToolkitCropControls() {
    var btnCrop = document.getElementById("btn-tk-crop-execute");
    var cropModal = document.getElementById("tk-crop-warning-modal");

    function executeCrop(duplicateShared) {
        ToolBridge.call({
            key: "crop.execute",
            script: 'toolkitCropPrecomp(' + (duplicateShared ? "true" : "false") + ')',
            button: btnCrop,
            // Crop samples layer bounds across the work area on the AE thread;
            // large precomps legitimately take longer than the default bound.
            timeoutMs: 120000,
            onResult: function (result) {
                if (result.status !== "success") return; // timeout/host-error already toasted

                var res = {};
                try { res = JSON.parse(result.decoded); } catch (e) { res = { ok: false, error: result.decoded }; }

                if (!res.ok) {
                    showToast(res.error || "Crop failed", "error");
                    return;
                }

                var croppedCount = res.croppedCount || 0;
                showToast("Cropped " + croppedCount + " precomp(s)", "success");

                if (res.warnings && res.warnings.length > 0) {
                    console.warn("[CompSaver] Crop warnings:", res.warnings);
                    showToast(res.warnings[0], "info");
                }
                updateActiveCompMonitor();
            }
        });
    }

    if (btnCrop) {
        btnCrop.addEventListener("click", function () {
            ToolBridge.call({
                key: "crop.preflight",
                script: "toolkitCheckSharedPrecomps()",
                button: btnCrop,
                onResult: function (result) {
                    if (result.status !== "success") return;

                    var res = {};
                    try { res = JSON.parse(result.decoded); } catch (e) { res = { ok: false, error: result.decoded }; }

                    if (!res.ok) {
                        showToast(res.error || "Check failed", "error");
                        return;
                    }

                    if (res.shared) {
                        if (cropModal) cropModal.classList.add("open");
                    } else {
                        executeCrop(false);
                    }
                }
            });
        });
    }

    if (cropModal) {
        var btnAll = document.getElementById("btn-crop-warn-all");
        var btnDup = document.getElementById("btn-crop-warn-dup");
        var btnCancel = document.getElementById("btn-crop-warn-cancel");

        if (btnAll) {
            btnAll.addEventListener("click", function () {
                cropModal.classList.remove("open");
                executeCrop(false);
            });
        }
        if (btnDup) {
            btnDup.addEventListener("click", function () {
                cropModal.classList.remove("open");
                executeCrop(true);
            });
        }
        if (btnCancel) {
            btnCancel.addEventListener("click", function () {
                cropModal.classList.remove("open");
            });
        }

        cropModal.addEventListener("click", function (e) {
            if (e.target === this) {
                cropModal.classList.remove("open");
            }
        });
    }
}

// =========================================================
// FLOW SYSTEM (easing-curve editor) - extracted to js/toolkit/flow.js
// (normalizeCurveForView + FlowSystem + initFlowSystem/Observer;
//  loaded before main.js, resolved via global scope)
// =========================================================

// Rapid-use tools that should be silent on success
var SILENT_SUCCESS_ACTIONS = { anchor: true, align: true, sequence: true, "guides-on": true, "guides-off": true, "delete-expression": true };

// ── Feedback policy (Req 1.8, 1.9, 14.9–14.11, 14.13) ────────────────
// Names used in error toasts and the "<label> done" success text.
var ACTION_LABELS = {
    anchor: "Anchor point", align: "Align", create: "Create layer", organize: "Organize project",
    effects: "Toggle effects", precompose: "Smart Precompose", unprecompose: "Un-precompose",
    cache: "Purge cache", multiprecomp: "Multi-Precompose", sequence: "Sequence & Stagger",
    truedup: "True Duplicate", decompose: "De-compose", resize: "Resize", bounce: "Bounce",
    "guides-on": "Guides On", "guides-off": "Guides Off", "delete-expression": "Remove Expressions",
    paste: "Paste Image", "effect-save": "Save preset", "effect-apply": "Apply preset",
    "effect-favorite": "Favorite preset", "effect-rename": "Rename preset", "effect-delete": "Delete preset",
    "oneframer": "Apply One-Framer", "mirror": "Mirror layers", "blend-mode": "Set blend mode",
    "speed-ramp": "Speed ramp", "reverse-video": "Reverse video", "split-playhead": "Split layers",
    "compact-remap": "Compact Time Remap", "text-box": "Create text background",
    "split-text": "Split text", "find-replace": "Find and replace text", "aspect-ratio": "Set aspect ratio",
    "toggle-ig-guide": "Instagram Reel Guide"
};

// Exact precondition strings the legacy Host functions return, by code.
var TOOLKIT_LEGACY_PRECONDITIONS = Object.freeze({
    "Open a composition first.": "no-comp",
    "Open a comp, or select comp(s)/precomp(s) first.": "no-comp",
    "No project open.": "no-project",
    "Select at least one layer.": "no-selection",
    "Select layer(s) to pre-compose.": "no-selection",
    "Select layers to pre-compose first.": "no-selection",
    "Select layers to sequence first.": "no-selection",
    "Select precomp layers first.": "no-selection",
    "Select at least one unlocked precomp layer.": "no-precomp",
    "Select a layer with keyframes first.": "no-keyframes",
    "No animated properties found. Add keyframes first.": "no-keyframes"
});

var TOOLKIT_PRECONDITION_TEXTS = {
    "no-comp": "\u26a0 Open a composition first",
    "no-selection": "Select at least one layer first",
    "no-project": "\u26a0 Open a project first",
    "no-precomp": "\u26a0 Select at least one precomp layer first",
    "no-keyframes": "\u26a0 Select a layer with keyframes first",
    "need-two": "\u26a0 Select two or more layers to align them to each other",
    "no-span": "\u26a0 No selected layer spans the playhead",
    "no-text-layer": "\u26a0 Select at least one text layer first",
    "one-text-layer": "\u26a0 Select exactly one text layer to split",
    "split-empty": "\u26a0 This text has nothing to split"
};

var TOOLKIT_ANCHOR_TEXTS = {
    top_left: "top left", top: "top center", top_right: "top right",
    left: "center left", center: "center", right: "center right",
    bottom_left: "bottom left", bottom: "bottom center", bottom_right: "bottom right"
};

var TOOLKIT_ALIGN_EDGES = {
    left: "left edge", hcenter: "horizontal center", right: "right edge",
    top: "top edge", vcenter: "vertical center", bottom: "bottom edge"
};

// Rule R formatters: action -> function (report) returning { kind, message, followUp? }.
// Filled by the Workbench actions of Milestones 5 and 6.
var TOOLKIT_REPORT_FORMATTERS = {};

// Skip reason keys to their texts (rule R follow-ups).
var TOOLKIT_SKIP_REASONS = {
    "no-remap": "Time Remap isn't available on them",
    "few-keys": "they have fewer than 2 Time Remap keyframes",
    "locked": "they're locked",
    "no-scale": "they have no Scale",
    "not-av": "cameras and lights have no blend mode",
    "no-span": "they don't span the playhead",
    "matte": "they are track mattes or use one"
};

function toolkitActionLabel(action, mode) {
    return ACTION_LABELS[action] || String(action || "Tool");
}

function toolkitCut(text, max) {
    var s = String(text == null ? "" : text);
    return s.length > max ? s.slice(0, max) : s;
}

function toolkitSuccessText(action, mode) {
    var m = String(mode || "");
    if (action === "anchor") return "\u2713 Anchor point set to " + (TOOLKIT_ANCHOR_TEXTS[m] || m.replace(/_/g, " "));
    if (action === "align") {
        var parts = m.split("|");
        var edge = TOOLKIT_ALIGN_EDGES[parts[0]] || parts[0].replace(/_/g, " ");
        return "\u2713 Aligned to " + edge + " of " + (parts[1] === "selection" ? "Selection" : "Comp");
    }
    if (action === "sequence") return "\u2713 Layers sequenced";
    if (action === "guides-on") return "\u2713 Guides added";
    if (action === "guides-off") return "\u2713 Guides cleared";
    if (action === "delete-expression") return "\u2713 Expressions removed";
    return "\u2713 " + toolkitActionLabel(action, mode) + " done";
}

/** Pure: { kind, message, code, followUp? } for a decoded Host result. */
function classifyToolkitResult(action, mode, decoded) {
    var text = decoded == null ? "" : String(decoded);
    // Rule 1: plain success.
    if (text === "true") return { kind: "success", message: toolkitSuccessText(action, mode), code: "ok" };
    // Rule 2: PRE:<code>:<message>.
    if (text.indexOf("PRE:") === 0) {
        var rest = text.slice(4);
        var sep = rest.indexOf(":");
        var code = sep === -1 ? rest : rest.slice(0, sep);
        var msg = sep === -1 ? "" : rest.slice(sep + 1);
        var known = TOOLKIT_PRECONDITION_TEXTS[code];
        return { kind: "warning", message: known || ("\u26a0 " + (msg || code)), code: code };
    }
    // Rule 3: legacy precondition strings.
    if (Object.prototype.hasOwnProperty.call(TOOLKIT_LEGACY_PRECONDITIONS, text)) {
        var legacyCode = TOOLKIT_LEGACY_PRECONDITIONS[text];
        return { kind: "warning", message: TOOLKIT_PRECONDITION_TEXTS[legacyCode], code: legacyCode };
    }
    // Rule R: OK:{...} reports of the Workbench actions.
    if (text.indexOf("OK:{") === 0 && typeof TOOLKIT_REPORT_FORMATTERS[action] === "function") {
        var report = null;
        try { report = JSON.parse(text.slice(3)); } catch (e) { report = null; }
        if (report && typeof report === "object" && report.op === action) {
            var formatted = TOOLKIT_REPORT_FORMATTERS[action](report, mode);
            if (formatted && formatted.kind && formatted.message) {
                var out = { kind: formatted.kind, message: formatted.message, code: "report" };
                if (formatted.followUp) out.followUp = formatted.followUp;
                return out;
            }
        }
    }
    // Rule 4: partial results of anchor and align.
    if (text.indexOf("OK:") === 0 && (action === "anchor" || action === "align")) {
        return { kind: "info", message: text.slice(3), code: "partial" };
    }
    // Rule 5: other OK: results.
    if (text.indexOf("OK:") === 0) {
        var body = text.slice(3);
        if (/; skipped [1-9][0-9]*\b/.test(body)) return { kind: "warning", message: body, code: "partial" };
        return { kind: "success", message: body ? "\u2713 " + body : toolkitSuccessText(action, mode), code: "ok" };
    }
    // Rule 6: anything else is an error.
    return { kind: "error", message: "\u2715 " + toolkitActionLabel(action, mode) + " failed: " + toolkitCut(text, 160), code: "host-error" };
}

function toolkitQuietRapidTools() {
    try {
        return typeof Settings !== "undefined" && Settings && typeof Settings.get === "function" &&
            Settings.get("toolkit.quietRapidTools") === true;
    } catch (e) { return false; }
}

function toolkitRequestMonitorRefresh() {
    if (typeof CompMonitor !== "undefined" && CompMonitor && typeof CompMonitor.refresh === "function") {
        CompMonitor.refresh("toolkit");
    }
}

function toolkitFlash(btn) {
    if (!btn || !btn.classList) return;
    btn.classList.add("apply-flash");
    setTimeout(function () { btn.classList.remove("apply-flash"); }, 600);
}

/** Called from ToolBridge's onResult for every dispatcher Host call. */
function reportToolkitResult(action, mode, result, btn) {
    toolkitRequestMonitorRefresh();
    // timeout / host-error / disposed: ToolBridge toasts the cause right after
    // onResult returns, in this task; prefix it with the action's name.
    if (!result || result.status !== "success") {
        if (result && result.error && result.error.message && typeof CompSaverToast !== "undefined" &&
            CompSaverToast && typeof CompSaverToast.prefixNext === "function") {
            CompSaverToast.prefixNext(result.error.message, "\u2715 " + toolkitActionLabel(action, mode) + ": ");
        }
        return null;
    }
    var decoded = result.decoded;

    // FX toggle: reflect the new state on the button.
    if (action === "effects" && btn && typeof decoded === "string") {
        if (decoded.indexOf("Effects disabled") !== -1) btn.classList.add("active");
        else if (decoded.indexOf("Effects restored") !== -1) btn.classList.remove("active");
    }

    var c = classifyToolkitResult(action, mode, decoded);
    if (c.kind === "error") console.warn("[CompSaver] Toolkit:", action, decoded);
    if (c.kind === "success" && SILENT_SUCCESS_ACTIONS[action] && toolkitQuietRapidTools()) {
        if (action !== "anchor") toolkitFlash(btn);
        return c;
    }
    showToast(c.message, c.kind);
    if (c.followUp) showToast(c.followUp.message, c.followUp.kind);
    return c;
}

function runToolkitAction(action, mode, btn, event) {
    if (action === "align" && String(mode).indexOf("|") === -1 && typeof CompSaverWorkbench !== "undefined") {
        mode += "|" + (CompSaverWorkbench.optionValue("align-scope") || "comp");
    }
    // Instantly toggle active style on anchor grid cells
    if (action === "anchor" && btn) {
        var apBtns = document.querySelectorAll(".tk-ap-btn");
        for (var i = 0; i < apBtns.length; i++) {
            apBtns[i].classList.remove("active");
        }
        btn.classList.add("active");
    }

    var jsx = "";
    if (action === "anchor") jsx = 'toolkitAnchorPoint("' + encodeBridge(mode) + '")';
    else if (action === "align") jsx = 'toolkitAlignLayers("' + encodeBridge(mode) + '")';
    else if (action === "create") {
        // Special Null behavior: normal click = single parent null for all selected layers
        // Shift+click = per-layer individual nulls (original behavior)
        if (mode === "null" && (!event || !event.shiftKey)) {
            jsx = 'toolkitCreateParentNull()';
        } else {
            jsx = 'toolkitCreateLayer("' + encodeBridge(mode) + '")';
        }
    }
    else if (action === "organize") jsx = "toolkitOrganizeProject()";
    else if (action === "effects") jsx = "toolkitToggleEffects()";
    else if (action === "precompose") jsx = "toolkitPrecompose()";
    else if (action === "unprecompose") jsx = "toolkitUnprecompose()";
    else if (action === "cache") jsx = "toolkitClearCache()";
    else if (action === "multiprecomp") jsx = 'toolkitMultiPrecomp("' + encodeBridge(mode) + '")';
    else if (action === "sequence") jsx = 'toolkitSequenceLayers("' + encodeBridge(mode) + '")';
    else if (action === "truedup") jsx = "toolkitTrueDuplicate()";
    else if (action === "decompose") jsx = "toolkitDeCompose()";
    else if (action === "resize") jsx = 'toolkitResizeCompTree("' + encodeBridge(mode) + '")';
    else if (action === "bounce") jsx = 'toolkitApplyBounce("' + encodeBridge(mode) + '")';
    else if (action === "guides-on") jsx = "toolkitAddGuides()";
    else if (action === "guides-off") jsx = "toolkitClearGuides()";
    else if (action === "toggle-ig-guide") {
        var guidePath = csInterface.getSystemPath(SystemPath.EXTENSION).replace(/\\/g, "/") + "/assets/guides/ig_reel_guide_1080x1920.png";
        jsx = 'toolkitToggleIGReelGuide("' + encodeBridge(guidePath) + '")';
    }
    else if (action === "delete-expression") jsx = "toolkitRemoveExpressions()";
    else if (action === "mirror") jsx = 'toolkitMirrorLayers("' + encodeBridge(mode) + '")';
    else if (action === "blend-mode") jsx = 'toolkitBatchBlendMode("' + encodeBridge((document.getElementById("cs-wb-blend") || {}).value || mode) + '")';
    else if (action === "split-playhead") jsx = "toolkitSplitAtPlayhead()";
    else if (action === "reverse-video") jsx = "toolkitReverseVideo()";
    else if (action === "speed-ramp") jsx = 'toolkitApplySpeedRamp("' + encodeBridge(mode) + '")';
    else if (action === "compact-remap") jsx = "toolkitCompactTimeRemap()";
    else if (action === "aspect-ratio") jsx = 'toolkitSetAspectRatio("' + encodeBridge(mode) + '")';
    else if (action === "text-box") jsx = "toolkitCreateResponsiveTextBox()";
    else if (action === "split-text") {
        var splitOptions = { mode: mode, stagger: Number((document.getElementById("cs-wb-text-stagger") || {}).value) || 0 };
        jsx = 'toolkitSplitText("' + encodeBridge(JSON.stringify(splitOptions)) + '")';
    }
    else if (action === "find-replace") {
        var findOptions = {
            find: (document.getElementById("cs-wb-find") || {}).value || "",
            replace: (document.getElementById("cs-wb-replace") || {}).value || "",
            scope: (document.getElementById("cs-wb-find-scope") || {}).value || "selection",
            matchCase: !!(document.getElementById("cs-wb-match-case") || {}).checked
        };
        if (!findOptions.find) { showToast("Enter text to find", "warning"); return; }
        if (findOptions.scope === "project" && !window.confirm("Replace matching text throughout the project? This can be undone in After Effects.")) return;
        jsx = 'toolkitFindReplaceText("' + encodeBridge(JSON.stringify(findOptions)) + '")';
    }
    else if (action === "text-preset") {
        if (typeof TextAnim !== "undefined" && typeof TextAnim.applyPreset === "function") TextAnim.applyPreset(mode);
        else showToast("Text presets are unavailable", "warning");
        return;
    }
    else if (action === "effect-save") {
        handleEffectSave(btn);
        return;
    }
    else if (action === "effect-apply") {
        handleEffectApply(btn);
        return;
    }
    else if (action === "effect-favorite") {
        handleEffectFavorite(btn);
        return;
    }
    else if (action === "effect-rename") {
        handleEffectRename(btn);
        return;
    }
    else if (action === "effect-delete") {
        handleEffectDelete(btn);
        return;
    }
    else if (action === "paste") {
        PasteController.handleImagePaste(btn);
        return;
    }

    if (!jsx) return;

    ToolBridge.call({
        key: "toolkit." + action,
        script: jsx,
        button: btn || null,
        onResult: function (result) {
            reportToolkitResult(action, mode, result, btn);
        }
    });
}

// ── sequencer controls ──────────────────────────────────────────
// initSequencerControls + steppers. Uses runToolkitAction (above) and the
// shared selectedStaggerMode (core/state.js). init() calls initSequencerControls.

function initSequencerControls() {
    var lifecycleMode = typeof FeatureFlags !== "undefined" && FeatureFlags.flags.lifecycleV1 &&
        typeof AppLifecycle !== "undefined";
    var modeBtns = document.querySelectorAll("[data-seq-mode]");
    var inputStep = document.getElementById("seq-step");
    var inputGroup = document.getElementById("seq-group");

    // Apply defaults from Settings
    if (inputStep) inputStep.value = Settings.get("toolkit.sequencerStep");
    if (inputGroup) inputGroup.value = 1;

    // Set initial mode from Settings
    var defaultMode = Settings.get("toolkit.sequencerMode");
    for (var m = 0; m < modeBtns.length; m++) {
        if (modeBtns[m].dataset.seqMode === defaultMode) {
            modeBtns[m].classList.add("active");
            selectedStaggerMode = defaultMode;
        }
    }

    // Factory function for steppers
    function buildStepper(stepperId, minVal, maxVal) {
        var stepperEl = document.getElementById(stepperId);
        if (!stepperEl) return;

        var inputEl = stepperEl.querySelector('.tk-stepper-val');
        var btnDn = stepperEl.querySelector('[data-dir="dn"]');
        var btnUp = stepperEl.querySelector('[data-dir="up"]');
        if (!inputEl || !btnDn || !btnUp) return;

        function getValue() {
            var v = parseInt(inputEl.value, 10);
            return isNaN(v) ? 0 : v;
        }

        function setValue(v) {
            if (minVal !== null && v < minVal) v = minVal;
            if (maxVal !== null && v > maxVal) v = maxVal;
            inputEl.value = v;
        }

        function stepBy(amount) {
            setValue(getValue() + amount);
        }

        var repeatTimer = null;
        var startTimer = null;

        function startRepeat(amount) {
            stopRepeat();
            stepBy(amount);
            startTimer = setTimeout(function () {
                repeatTimer = setInterval(function () {
                    stepBy(amount);
                }, 80);
            }, 400);
        }

        function stopRepeat() {
            if (startTimer) clearTimeout(startTimer);
            if (repeatTimer) clearInterval(repeatTimer);
            startTimer = null;
            repeatTimer = null;
        }

        btnDn.addEventListener('mousedown', function (e) { e.preventDefault(); startRepeat(-1); });
        btnUp.addEventListener('mousedown', function (e) { e.preventDefault(); startRepeat(1); });

        if (lifecycleMode) {
            AppLifecycle.listen(window, 'mouseup', stopRepeat);
            AppLifecycle.listen(stepperEl, 'mouseleave', stopRepeat);
            AppLifecycle.register("timer", stepperEl, stopRepeat);
        } else {
            window.addEventListener('mouseup', stopRepeat);
            stepperEl.addEventListener('mouseleave', stopRepeat);
        }

        stepperEl.addEventListener('wheel', function (e) {
            e.preventDefault();
            var dir = e.deltaY < 0 ? 1 : -1;
            var amount = e.shiftKey ? 10 * dir : dir;
            stepBy(amount);
        });

        stepperEl.tabIndex = 0;
        stepperEl.addEventListener('keydown', function (e) {
            if (e.key === "ArrowUp") {
                e.preventDefault();
                stepBy(e.shiftKey ? 10 : 1);
            } else if (e.key === "ArrowDown") {
                e.preventDefault();
                stepBy(e.shiftKey ? -10 : -1);
            }
        });
    }

    buildStepper("stepper-seq-group", 1, null);
    buildStepper("stepper-seq-step", -500, 500);

    for (var i = 0; i < modeBtns.length; i++) {
        modeBtns[i].addEventListener("click", function () {
            for (var j = 0; j < modeBtns.length; j++) {
                modeBtns[j].classList.remove("active");
            }
            this.classList.add("active");
            selectedStaggerMode = this.dataset.seqMode;

            // Immediately execute stagger on click!
            var step = parseInt(inputStep ? inputStep.value : "1", 10);
            var group = parseInt(inputGroup ? inputGroup.value : "0", 10);
            if (isNaN(step)) step = 1;
            if (isNaN(group) || group < 1) group = 1;

            runToolkitAction("sequence", selectedStaggerMode + "|" + step + "|" + group, this);
        });
    }
}
