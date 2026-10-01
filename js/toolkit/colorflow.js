// ============================================================
// toolkit/colorflow.js - palette + color application module
// ------------------------------------------------------------
// Self-contained ColorFlow object (palettes, swatches, HSV editor,
// apply-to-layer). Moved verbatim from main.js. Depends only on
// globals: showToast, encodeBridge/decodeBridge, csInterface,
// localStorage. ColorFlow.init() is called from init() in main.js.
// Loaded before main.js.
// ============================================================

// =========================================================
// COLORFLOW MODULE
// =========================================================

// Minimum spacing between live-drag host calls (ms). One trailing call
// guarantees the final drag color still lands in AE.
var COLORFLOW_LIVE_INTERVAL_MS = 100;

var ColorFlow = {
    palettes: [],
    activePaletteIndex: 0,
    selectedSwatchIndex: 0, // Default to first swatch
    activeColorTarget: "fill", // Tracks last used coloring target ("fill" or "stroke")
    editorOpen: false,
    // Single snapshot taken when the workshop opens; used to revert on Cancel.
    // Cleared after use. Replaces the previous originalColor / originalPaletteColors /
    // originalSelectedSwatchIndex triple-cache.
    snapshot: null,
    // Temporary Shift-stroke override flags. Both clear on workshop close.
    // updateEditorColor reads (sessionShiftOverride || dragShiftActive) to decide
    // live-apply target. activeColorTarget is never mutated by Shift.
    sessionShiftOverride: false, // Set on workshop open if Shift was held
    dragShiftActive: false,      // Set during SV/hue drag or hex Enter
    modalPaletteColors: [], // Working copy of active palette colors inside the modal editor

    currentH: 0,
    currentS: 1,
    currentV: 1,

    init: function () {
        this.loadFromStorage();

        // Restore last-used target from Settings (takes priority), then legacy localStorage
        var settingsTarget = Settings.get("toolkit.colorflowTarget");
        if (settingsTarget === "fill" || settingsTarget === "stroke" || settingsTarget === "both") {
            this.activeColorTarget = settingsTarget === "both" ? "fill" : settingsTarget;
        } else {
            try {
                var savedTarget = localStorage.getItem("cs_colorflow_target");
                if (savedTarget === "fill" || savedTarget === "label") {
                    this.activeColorTarget = savedTarget;
                }
            } catch (e) { }
        }

        this.renderPalettesDropdown();
        this.renderSwatches();
        this.renderTargetToggle();
        this.bindEvents();
    },

    loadFromStorage: function () {
        try {
            var saved = localStorage.getItem("cs_colorflow_palettes");
            if (saved) {
                this.palettes = JSON.parse(saved);
                // Normalize to exactly 8 colors
                for (var i = 0; i < this.palettes.length; i++) {
                    var p = this.palettes[i];
                    if (!p.colors || p.colors.length < 8) {
                        p.colors = p.colors || [];
                        while (p.colors.length < 8) {
                            p.colors.push(p.colors[p.colors.length - 1] || "#1E1E24");
                        }
                    } else if (p.colors.length > 8) {
                        p.colors = p.colors.slice(0, 8);
                    }
                }
            } else {
                // Seed defaults with exactly 8 colors each
                this.palettes = [
                    { name: "Neon Cyber", colors: ["#FF0055", "#00FFCC", "#9900FF", "#0099FF", "#FFB7B2", "#FFDAC1", "#1E1E24", "#E2F0CB"] },
                    { name: "Pastel Dream", colors: ["#FFB7B2", "#FFDAC1", "#E2F0CB", "#B5EAD7", "#C7CEEA", "#FFC6FF", "#BDB2FF", "#A0C4FF"] },
                    { name: "Vibrant Tech", colors: ["#7B61FF", "#FF6B6B", "#FFD93D", "#6BCB77", "#4D96FF", "#F4A261", "#E76F51", "#2A9D8F"] },
                    { name: "Minimal Dark", colors: ["#1E1E24", "#3A3A43", "#7A7A8A", "#D1D1D6", "#F2F2F7", "#E5E5EA", "#AEAEB2", "#8E8E93"] }
                ];
                this.saveToStorage();
            }

            // Load default palette automatically — check Settings first, then legacy localStorage
            var defaultName = Settings.get("toolkit.colorflowDefaultPalette") || localStorage.getItem("cs_colorflow_default_palette_name") || "Neon Cyber";
            var foundIdx = -1;
            for (var j = 0; j < this.palettes.length; j++) {
                if (this.palettes[j].name === defaultName) {
                    foundIdx = j;
                    break;
                }
            }

            if (foundIdx !== -1) {
                this.activePaletteIndex = foundIdx;
            } else {
                var savedActive = localStorage.getItem("cs_colorflow_active_index");
                this.activePaletteIndex = savedActive ? parseInt(savedActive, 10) : 0;
                if (this.activePaletteIndex >= this.palettes.length) this.activePaletteIndex = 0;
            }
        } catch (e) {
            console.error("Error loading ColorFlow storage:", e);
        }
    },

    saveToStorage: function () {
        try {
            localStorage.setItem("cs_colorflow_palettes", JSON.stringify(this.palettes));
            localStorage.setItem("cs_colorflow_active_index", this.activePaletteIndex.toString());
        } catch (e) {
            console.error("Error saving ColorFlow storage:", e);
        }
    },

    renderPalettesDropdown: function () {
        var select = document.getElementById("flow-palette-select");
        if (!select) return;
        select.innerHTML = "";
        var i;
        for (i = 0; i < this.palettes.length; i++) {
            var opt = document.createElement("option");
            opt.value = i;
            opt.textContent = this.palettes[i].name;
            if (i === this.activePaletteIndex) opt.selected = true;
            select.appendChild(opt);
        }
    },

    renderModalPalettesDropdown: function () {
        var select = document.getElementById("flow-modal-palette-select");
        if (!select) return;
        select.innerHTML = "";
        var i;
        for (i = 0; i < this.palettes.length; i++) {
            var opt = document.createElement("option");
            opt.value = i;
            opt.textContent = this.palettes[i].name;
            if (i === this.activePaletteIndex) opt.selected = true;
            select.appendChild(opt);
        }
    },

    renderSwatches: function () {
        var activeContainer = document.getElementById("flow-swatches");
        if (activeContainer) {
            activeContainer.innerHTML = "";
            var currentPalette = this.palettes[this.activePaletteIndex];
            if (currentPalette && currentPalette.colors) {
                var i;
                for (i = 0; i < currentPalette.colors.length; i++) {
                    var col = currentPalette.colors[i];
                    var swatch = document.createElement("div");
                    swatch.className = "flow-swatch";
                    if (i === this.selectedSwatchIndex) {
                        swatch.className += " selected";
                    }
                    swatch.style.backgroundColor = col;
                    swatch.dataset.color = col;
                    swatch.dataset.index = i;
                    activeContainer.appendChild(swatch);
                }
            }
        }
    },

    // Reflect activeColorTarget on the F/S/L toggle buttons
    renderTargetToggle: function () {
        var btns = document.querySelectorAll(".flow-target-btn");
        for (var i = 0; i < btns.length; i++) {
            btns[i].classList.toggle("active", btns[i].dataset.target === this.activeColorTarget);
        }
    },

    // Single point of entry to change the active apply target
    setTarget: function (target) {
        if (target !== "fill" && target !== "label") return;
        this.activeColorTarget = target;
        try { localStorage.setItem("cs_colorflow_target", target); } catch (e) { }
        this.renderTargetToggle();
    },

    renderModalSwatches: function () {
        var modalContainer = document.getElementById("flow-modal-swatches");
        if (modalContainer) {
            modalContainer.innerHTML = "";
            var i;
            for (i = 0; i < this.modalPaletteColors.length; i++) {
                var col = this.modalPaletteColors[i];
                var swatch = document.createElement("div");
                swatch.className = "flow-swatch";
                if (i === this.selectedSwatchIndex) {
                    swatch.className += " selected";
                }
                swatch.style.backgroundColor = col;
                swatch.dataset.color = col;
                swatch.dataset.index = i;
                swatch.draggable = true; // Enable lightweight drag and drop
                modalContainer.appendChild(swatch);
            }
        }
    },

    // Color conversion helpers (ES5 Safe)
    hexToRgb: function (hex) {
        hex = hex.replace(/^#/, '');
        if (hex.length === 3) {
            hex = hex.split('').map(function (c) { return c + c; }).join('');
        }
        var num = parseInt(hex, 16);
        return {
            r: (num >> 16) & 255,
            g: (num >> 8) & 255,
            b: num & 255
        };
    },

    rgbToHex: function (r, g, b) {
        var rHex = Math.round(r).toString(16).toUpperCase();
        var gHex = Math.round(g).toString(16).toUpperCase();
        var bHex = Math.round(b).toString(16).toUpperCase();
        if (rHex.length < 2) rHex = "0" + rHex;
        if (gHex.length < 2) gHex = "0" + gHex;
        if (bHex.length < 2) bHex = "0" + bHex;
        return '#' + rHex + gHex + bHex;
    },

    rgbToHsv: function (r, g, b) {
        r /= 255; g /= 255; b /= 255;
        var max = Math.max(r, g, b), min = Math.min(r, g, b);
        var h, s, v = max;
        var d = max - min;
        s = max === 0 ? 0 : d / max;
        if (max === min) {
            h = 0; // achromatic
        } else {
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }
        return { h: h * 360, s: s, v: v };
    },

    hsvToRgb: function (h, s, v) {
        var r, g, b;
        var i = Math.floor(h / 60);
        var f = h / 60 - i;
        var p = v * (1 - s);
        var q = v * (1 - f * s);
        var t = v * (1 - (1 - f) * s);
        switch (i % 6) {
            case 0: r = v, g = t, b = p; break;
            case 1: r = q, g = v, b = p; break;
            case 2: r = p, g = v, b = t; break;
            case 3: r = p, g = q, b = v; break;
            case 4: r = t, g = p, b = v; break;
            case 5: r = v, g = p, b = q; break;
        }
        return { r: r * 255, g: g * 255, b: b * 255 };
    },

    updateEditorUI: function () {
        var handleSV = document.getElementById("flow-modal-sv-handle");
        var handleHue = document.getElementById("flow-modal-hue-handle");
        var svBox = document.getElementById("flow-modal-sv");
        var editorHexInput = document.getElementById("flow-modal-hex-input");
        var preview = document.getElementById("flow-modal-preview");

        if (svBox) {
            var hueRgb = this.hsvToRgb(this.currentH, 1, 1);
            var hueHex = this.rgbToHex(hueRgb.r, hueRgb.g, hueRgb.b);
            svBox.style.backgroundColor = hueHex;
        }

        if (handleSV) {
            handleSV.style.left = (this.currentS * 100) + "%";
            handleSV.style.top = ((1 - this.currentV) * 100) + "%";
        }

        if (handleHue) {
            handleHue.style.top = (this.currentH / 360 * 100) + "%";
        }

        var rgb = this.hsvToRgb(this.currentH, this.currentS, this.currentV);
        var hex = this.rgbToHex(rgb.r, rgb.g, rgb.b);

        if (editorHexInput) {
            editorHexInput.value = hex;
        }

        if (preview) {
            preview.style.backgroundColor = hex;
        }
    },

    updateEditorColor: function (applyLive) {
        var rgb = this.hsvToRgb(this.currentH, this.currentS, this.currentV);
        var hex = this.rgbToHex(rgb.r, rgb.g, rgb.b);

        var handleSV = document.getElementById("flow-modal-sv-handle");
        var handleHue = document.getElementById("flow-modal-hue-handle");
        var svBox = document.getElementById("flow-modal-sv");
        var editorHexInput = document.getElementById("flow-modal-hex-input");
        var preview = document.getElementById("flow-modal-preview");

        if (svBox) {
            var hueRgb = this.hsvToRgb(this.currentH, 1, 1);
            var hueHex = this.rgbToHex(hueRgb.r, hueRgb.g, hueRgb.b);
            svBox.style.backgroundColor = hueHex;
        }
        if (handleSV) {
            handleSV.style.left = (this.currentS * 100) + "%";
            handleSV.style.top = ((1 - this.currentV) * 100) + "%";
        }
        if (handleHue) {
            handleHue.style.top = (this.currentH / 360 * 100) + "%";
        }
        if (editorHexInput) {
            editorHexInput.value = hex;
        }
        if (preview) {
            preview.style.backgroundColor = hex;
        }

        // Update active swatch inside the modal palette row live in real time
        if (this.editorOpen && this.modalPaletteColors && this.selectedSwatchIndex !== null) {
            this.modalPaletteColors[this.selectedSwatchIndex] = hex;
            var modalSwatches = document.querySelectorAll("#flow-modal-swatches .flow-swatch");
            if (modalSwatches && modalSwatches[this.selectedSwatchIndex]) {
                modalSwatches[this.selectedSwatchIndex].style.backgroundColor = hex;
                modalSwatches[this.selectedSwatchIndex].dataset.color = hex;
            }
        }

        if (applyLive) {
            var liveApplyCheck = document.getElementById("flow-modal-live-apply");
            if (!liveApplyCheck || liveApplyCheck.checked) {
                // Single source of truth for live-apply target inside the workshop.
                // Stroke is used if EITHER:
                //   (a) workshop was opened with Shift held (session override), OR
                //   (b) the active interaction (SV/hue drag or hex Enter) holds Shift.
                // Otherwise, use the persistent toggle target. activeColorTarget is
                // never mutated by Shift. JSX engine falls back to fill on layer
                // types where stroke isn't applicable (e.g. solids, AV layers).
                var shiftOverride = this.sessionShiftOverride || this.dragShiftActive;
                var liveTarget = shiftOverride ? "stroke" : this.activeColorTarget;
                this.applyColorLive(hex, liveTarget);
            }
        }
    },

    bindEvents: function () {
        var self = this;

        // Target toggle (F/S/L) — single source of truth for activeColorTarget
        var toggle = document.getElementById("flow-target-toggle");
        if (toggle) {
            toggle.addEventListener("click", function (e) {
                var btn = e.target.closest(".flow-target-btn");
                if (!btn) return;
                self.setTarget(btn.dataset.target);
            });
        }

        // Dropdown switching
        var select = document.getElementById("flow-palette-select");
        if (select) {
            select.addEventListener("change", function () {
                self.activePaletteIndex = parseInt(this.value, 10);
                self.selectedSwatchIndex = 0; // Reset selection to first
                self.saveToStorage();
                self.renderSwatches();
            });
        }

        // Swatches click listeners
        var swatchesContainer = document.getElementById("flow-swatches");
        if (swatchesContainer) {
            // Single click → instant apply.
            // Shift+click → stroke override (temporary, doesn't change toggle state).
            // e.detail > 1 means this click is the 2nd (or later) of a dblclick burst,
            // so we let the dblclick handler take over and skip the apply.
            swatchesContainer.addEventListener("click", function (e) {
                if (e.detail > 1) return;
                var swatch = e.target.closest(".flow-swatch");
                if (!swatch) return;
                var col = swatch.dataset.color;
                var idx = parseInt(swatch.dataset.index, 10);

                self.selectedSwatchIndex = idx;
                self.renderSwatches();

                // Shift+click = stroke (one-shot override), otherwise use toggle target
                var target = e.shiftKey ? "stroke" : self.activeColorTarget;
                self.applyColor(col, target);
            });

            // Double click → open workshop focused on this swatch.
            // Shift+dblclick → workshop session targets stroke for live edits.
            swatchesContainer.addEventListener("dblclick", function (e) {
                var swatch = e.target.closest(".flow-swatch");
                if (!swatch) return;
                e.preventDefault();
                var idx = parseInt(swatch.dataset.index, 10);
                self.selectedSwatchIndex = idx;
                self.renderSwatches();
                self.openWorkshop(idx, e.shiftKey);
            });
        }

        // Main Strip Refresh Button
        var btnMainRefresh = document.getElementById("btn-flow-refresh");
        if (btnMainRefresh) {
            btnMainRefresh.addEventListener("click", function () {
                var defaultName = localStorage.getItem("cs_colorflow_default_palette_name") || "Neon Cyber";
                var foundIdx = -1;
                var i;
                for (i = 0; i < self.palettes.length; i++) {
                    if (self.palettes[i].name === defaultName) {
                        foundIdx = i;
                        break;
                    }
                }
                if (foundIdx !== -1) {
                    self.activePaletteIndex = foundIdx;
                    self.selectedSwatchIndex = 0;
                    // Refresh always returns target to Fill (primary mode)
                    self.setTarget("fill");
                    self.saveToStorage();
                    self.renderPalettesDropdown();
                    self.renderSwatches();
                } else {
                    showToast("No default palette set", "error");
                }
            });
        }

        // Dedicated Modal Editor Controls Events
        var modal = document.getElementById("flow-editor-modal");
        var btnEdit = document.getElementById("btn-flow-edit");
        var btnCancel = document.getElementById("btn-flow-modal-cancel");
        var btnConfirm = document.getElementById("btn-flow-modal-save");
        var svBox = document.getElementById("flow-modal-sv");
        var hueBox = document.getElementById("flow-modal-hue");
        var editorHexInput = document.getElementById("flow-modal-hex-input");

        var modalPaletteSelect = document.getElementById("flow-modal-palette-select");
        var btnModalRename = document.getElementById("btn-flow-modal-rename");
        var btnModalNew = document.getElementById("btn-flow-modal-new");
        var btnModalDelete = document.getElementById("btn-flow-modal-delete");
        var btnModalDefault = document.getElementById("btn-flow-modal-default");

        // Open Modal Color Editor (Shift held → stroke session)
        if (btnEdit) {
            btnEdit.addEventListener("click", function (e) {
                self.openWorkshop(undefined, e.shiftKey);
            });
        }

        // Palette switching inside modal
        if (modalPaletteSelect) {
            modalPaletteSelect.addEventListener("change", function () {
                var idx = parseInt(this.value, 10);
                self.activePaletteIndex = idx;
                self.selectedSwatchIndex = 0;

                var currentPalette = self.palettes[self.activePaletteIndex];
                self.modalPaletteColors = [].concat(currentPalette.colors);

                var col = self.modalPaletteColors[0] || "#FF0055";
                var rgb = self.hexToRgb(col);
                var hsv = self.rgbToHsv(rgb.r, rgb.g, rgb.b);
                self.currentH = hsv.h;
                self.currentS = hsv.s;
                self.currentV = hsv.v;

                self.updateEditorUI();
                self.renderModalSwatches();

                // Update default button highlight
                var defaultName = localStorage.getItem("cs_colorflow_default_palette_name") || "Neon Cyber";
                var isDefault = (currentPalette && currentPalette.name === defaultName);
                var defaultBtn = document.getElementById("btn-flow-modal-default");
                if (defaultBtn) defaultBtn.classList.toggle("active", isDefault);

                var liveApplyCheck = document.getElementById("flow-modal-live-apply");
                if (!liveApplyCheck || liveApplyCheck.checked) {
                    self.applyColor(col, "fill");
                }
            });
        }

        // Set palette as Default Palette
        if (btnModalDefault) {
            btnModalDefault.addEventListener("click", function () {
                var currentPalette = self.palettes[self.activePaletteIndex];
                if (!currentPalette) return;

                localStorage.setItem("cs_colorflow_default_palette_name", currentPalette.name);

                // Toggle active classes on default buttons
                var defaultName = localStorage.getItem("cs_colorflow_default_palette_name") || "Neon Cyber";
                var isDefault = (currentPalette.name === defaultName);
                btnModalDefault.classList.toggle("active", isDefault);

                showToast("Palette '" + currentPalette.name + "' set as startup default!", "success");
            });
        }



        // Rename palette inside modal
        if (btnModalRename) {
            btnModalRename.addEventListener("click", function () {
                var currentPalette = self.palettes[self.activePaletteIndex];
                if (!currentPalette) return;
                var oldName = currentPalette.name;
                var name = prompt("Rename palette '" + oldName + "' to:", oldName);
                if (!name) return;
                name = name.trim();
                if (!name || name === oldName) return;

                currentPalette.name = name;
                self.saveToStorage();
                self.renderPalettesDropdown();
                self.renderModalPalettesDropdown();
                showToast('Palette renamed to "' + name + '"', "success");
            });
        }

        // Create new palette inside modal
        if (btnModalNew) {
            btnModalNew.addEventListener("click", function () {
                var name = prompt("Name your new palette:");
                if (!name) return;
                name = name.trim();
                if (!name) return;

                // Initialize a fresh empty slate-gray palette with 8 neutral placeholders
                var newColors = ["#2C2C35", "#2C2C35", "#2C2C35", "#2C2C35", "#2C2C35", "#2C2C35", "#2C2C35", "#2C2C35"];
                self.palettes.push({
                    name: name,
                    colors: newColors
                });
                self.activePaletteIndex = self.palettes.length - 1;
                self.selectedSwatchIndex = 0;
                self.modalPaletteColors = [].concat(newColors);

                var col = self.modalPaletteColors[0] || "#2C2C35";
                var rgb = self.hexToRgb(col);
                var hsv = self.rgbToHsv(rgb.r, rgb.g, rgb.b);
                self.currentH = hsv.h;
                self.currentS = hsv.s;
                self.currentV = hsv.v;

                self.saveToStorage();
                self.renderPalettesDropdown();
                self.renderModalPalettesDropdown();
                self.renderModalSwatches();
                self.updateEditorUI();

                var defaultBtn = document.getElementById("btn-flow-modal-default");
                if (defaultBtn) defaultBtn.classList.remove("active");

                var liveApplyCheck = document.getElementById("flow-modal-live-apply");
                if (!liveApplyCheck || liveApplyCheck.checked) {
                    self.applyColor(col, "fill");
                }
                showToast("New blank palette created!", "success");
            });
        }

        // Delete palette inside modal
        if (btnModalDelete) {
            var deleteConfirmState = false;
            btnModalDelete.addEventListener("click", function () {
                if (self.palettes.length <= 1) {
                    showToast("Cannot delete last remaining palette!", "error");
                    return;
                }

                if (!deleteConfirmState) {
                    deleteConfirmState = true;
                    btnModalDelete.style.color = "#F43F5E";
                    btnModalDelete.title = "Click again to CONFIRM Delete";
                    showToast("Click again to confirm delete", "warning");

                    setTimeout(function () {
                        deleteConfirmState = false;
                        btnModalDelete.style.color = "";
                        btnModalDelete.title = "Delete Palette";
                    }, 3000);
                } else {
                    var nameToDelete = self.palettes[self.activePaletteIndex].name;
                    self.palettes.splice(self.activePaletteIndex, 1);

                    var defaultName = localStorage.getItem("cs_colorflow_default_palette_name");
                    if (defaultName === nameToDelete) {
                        localStorage.setItem("cs_colorflow_default_palette_name", self.palettes[0].name);
                    }

                    self.activePaletteIndex = 0;
                    self.selectedSwatchIndex = 0;
                    var currentPalette = self.palettes[0];
                    self.modalPaletteColors = [].concat(currentPalette.colors);

                    var col = self.modalPaletteColors[0] || "#FF0055";
                    var rgb = self.hexToRgb(col);
                    var hsv = self.rgbToHsv(rgb.r, rgb.g, rgb.b);
                    self.currentH = hsv.h;
                    self.currentS = hsv.s;
                    self.currentV = hsv.v;

                    self.saveToStorage();
                    self.renderPalettesDropdown();
                    self.renderModalPalettesDropdown();
                    self.renderModalSwatches();
                    self.updateEditorUI();

                    var defaultBtn = document.getElementById("btn-flow-modal-default");
                    if (defaultBtn) {
                        var isDefault = (currentPalette.name === localStorage.getItem("cs_colorflow_default_palette_name"));
                        defaultBtn.classList.toggle("active", isDefault);
                    }

                    var liveApplyCheck = document.getElementById("flow-modal-live-apply");
                    if (!liveApplyCheck || liveApplyCheck.checked) {
                        self.applyColor(col, "fill");
                    }

                    deleteConfirmState = false;
                    btnModalDelete.style.color = "";
                    btnModalDelete.title = "Delete Palette";
                    showToast("Palette deleted successfully", "success");
                }
            });
        }



        // Cancel and Revert Modal Editor
        if (btnCancel) {
            btnCancel.addEventListener("click", function () {
                if (!modal) return;

                FocusTrap.deactivate();
                modal.classList.remove("open");
                self.editorOpen = false;
                // Clear Shift override flags — no bleed between sessions
                self.sessionShiftOverride = false;
                self.dragShiftActive = false;

                var snap = self.snapshot;
                self.snapshot = null;
                if (!snap) return;

                // Restore palette colors and selection from the single snapshot
                var palette = self.palettes[self.activePaletteIndex];
                if (palette) {
                    palette.colors = [].concat(snap.colors);
                }
                self.selectedSwatchIndex = snap.selectedIndex;

                // Revert the AE comp live preview using the same target that was active
                var origCol = snap.colors[snap.selectedIndex];
                if (origCol) {
                    self.applyColor(origCol, snap.target || "fill");
                }

                self.renderSwatches();
            });
        }

        // Confirm and Save Modal Editor
        if (btnConfirm) {
            btnConfirm.addEventListener("click", function () {
                if (!modal) return;

                var palette = self.palettes[self.activePaletteIndex];
                if (palette && self.modalPaletteColors) {
                    palette.colors = [].concat(self.modalPaletteColors);
                }

                FocusTrap.deactivate();
                modal.classList.remove("open");
                self.editorOpen = false;
                self.snapshot = null;
                // Clear Shift override flags — no bleed between sessions
                self.sessionShiftOverride = false;
                self.dragShiftActive = false;

                self.saveToStorage();
                self.renderPalettesDropdown();
                self.renderSwatches();
            });
        }

        // Swatches click listener inside the modal
        var modalSwatchesContainer = document.getElementById("flow-modal-swatches");
        if (modalSwatchesContainer) {
            modalSwatchesContainer.addEventListener("click", function (e) {
                var swatch = e.target.closest(".flow-swatch");
                if (!swatch) return;
                var col = swatch.dataset.color;
                var idx = parseInt(swatch.dataset.index, 10);

                self.selectedSwatchIndex = idx;
                self.renderModalSwatches();

                var rgb = self.hexToRgb(col);
                var hsv = self.rgbToHsv(rgb.r, rgb.g, rgb.b);
                self.currentH = hsv.h;
                self.currentS = hsv.s;
                self.currentV = hsv.v;

                self.updateEditorUI();

                var liveApplyCheck = document.getElementById("flow-modal-live-apply");
                if (!liveApplyCheck || liveApplyCheck.checked) {
                    // Stroke if session override OR this click held Shift
                    var liveTarget = (self.sessionShiftOverride || e.shiftKey)
                        ? "stroke"
                        : self.activeColorTarget;
                    self.applyColor(col, liveTarget);
                }
            });

            // Drag and Drop reordering logic inside the modal swatches grid
            var dragSrcIndex = null;

            modalSwatchesContainer.addEventListener("dragstart", function (e) {
                var swatch = e.target.closest(".flow-swatch");
                if (!swatch) return;
                dragSrcIndex = parseInt(swatch.dataset.index, 10);
                e.dataTransfer.effectAllowed = "move";
                swatch.style.opacity = "0.4";
            });

            modalSwatchesContainer.addEventListener("dragover", function (e) {
                e.preventDefault();
                return false;
            });

            modalSwatchesContainer.addEventListener("dragend", function (e) {
                var swatch = e.target.closest(".flow-swatch");
                if (swatch) swatch.style.opacity = "1";
                var swatches = modalSwatchesContainer.querySelectorAll(".flow-swatch");
                for (var i = 0; i < swatches.length; i++) {
                    swatches[i].style.opacity = "1";
                }
            });

            modalSwatchesContainer.addEventListener("drop", function (e) {
                e.preventDefault();
                var swatch = e.target.closest(".flow-swatch");
                if (!swatch) return;
                var dragDestIndex = parseInt(swatch.dataset.index, 10);

                if (dragSrcIndex !== null && dragSrcIndex !== dragDestIndex) {
                    var colorToMove = self.modalPaletteColors[dragSrcIndex];
                    self.modalPaletteColors.splice(dragSrcIndex, 1);
                    self.modalPaletteColors.splice(dragDestIndex, 0, colorToMove);

                    if (self.selectedSwatchIndex === dragSrcIndex) {
                        self.selectedSwatchIndex = dragDestIndex;
                    } else if (self.selectedSwatchIndex > dragSrcIndex && self.selectedSwatchIndex <= dragDestIndex) {
                        self.selectedSwatchIndex--;
                    } else if (self.selectedSwatchIndex < dragSrcIndex && self.selectedSwatchIndex >= dragDestIndex) {
                        self.selectedSwatchIndex++;
                    }

                    self.renderModalSwatches();

                    var activeCol = self.modalPaletteColors[self.selectedSwatchIndex];
                    var liveApplyCheck = document.getElementById("flow-modal-live-apply");
                    if (!liveApplyCheck || liveApplyCheck.checked) {
                        self.applyColor(activeCol, self.activeColorTarget);
                    }
                }
            });
        }



        // SV box dragging logic
        if (svBox) {
            var isDraggingSV = false;
            var handleSVDrag = function (e) {
                var rect = svBox.getBoundingClientRect();
                var clientX = e.clientX;
                var clientY = e.clientY;
                if (e.touches && e.touches.length > 0) {
                    clientX = e.touches[0].clientX;
                    clientY = e.touches[0].clientY;
                }
                var x = clientX - rect.left;
                var y = clientY - rect.top;
                x = Math.max(0, Math.min(rect.width, x));
                y = Math.max(0, Math.min(rect.height, y));

                self.currentS = x / rect.width;
                self.currentV = 1 - (y / rect.height);
                // Re-read shift on every move so user can press/release mid-drag
                self.dragShiftActive = !!e.shiftKey;
                self.updateEditorColor(true);
            };

            svBox.addEventListener("mousedown", function (e) {
                isDraggingSV = true;
                self.dragShiftActive = !!e.shiftKey;
                handleSVDrag(e);
            });
            svBox.addEventListener("touchstart", function (e) {
                isDraggingSV = true;
                handleSVDrag(e);
            }, { passive: true });

            window.addEventListener("mousemove", function (e) {
                if (isDraggingSV) handleSVDrag(e);
            });
            window.addEventListener("touchmove", function (e) {
                if (isDraggingSV) handleSVDrag(e);
            }, { passive: true });

            window.addEventListener("mouseup", function () {
                if (isDraggingSV) self.dragShiftActive = false;
                isDraggingSV = false;
            });
            window.addEventListener("touchend", function () {
                if (isDraggingSV) self.dragShiftActive = false;
                isDraggingSV = false;
            });
        }

        // Hue vertical bar dragging logic
        if (hueBox) {
            var isDraggingHue = false;
            var handleHueDrag = function (e) {
                var rect = hueBox.getBoundingClientRect();
                var clientY = e.clientY;
                if (e.touches && e.touches.length > 0) {
                    clientY = e.touches[0].clientY;
                }
                var y = clientY - rect.top;
                y = Math.max(0, Math.min(rect.height, y));

                self.currentH = (y / rect.height) * 360;
                self.dragShiftActive = !!e.shiftKey;
                self.updateEditorColor(true);
            };

            hueBox.addEventListener("mousedown", function (e) {
                isDraggingHue = true;
                self.dragShiftActive = !!e.shiftKey;
                handleHueDrag(e);
            });
            hueBox.addEventListener("touchstart", function (e) {
                isDraggingHue = true;
                handleHueDrag(e);
            }, { passive: true });

            window.addEventListener("mousemove", function (e) {
                if (isDraggingHue) handleHueDrag(e);
            });
            window.addEventListener("touchmove", function (e) {
                if (isDraggingHue) handleHueDrag(e);
            }, { passive: true });

            window.addEventListener("mouseup", function () {
                if (isDraggingHue) self.dragShiftActive = false;
                isDraggingHue = false;
            });
            window.addEventListener("touchend", function () {
                if (isDraggingHue) self.dragShiftActive = false;
                isDraggingHue = false;
            });
        }

        // Hex input confirmation on Enter
        if (editorHexInput) {
            editorHexInput.addEventListener("keydown", function (e) {
                if (e.key === "Enter") {
                    var val = editorHexInput.value.trim().toUpperCase();
                    if (val.charAt(0) !== "#") val = "#" + val;
                    var reg = /^#([0-9a-fA-F]{3}){1,2}$/;
                    if (reg.test(val)) {
                        var rgb = self.hexToRgb(val);
                        var hsv = self.rgbToHsv(rgb.r, rgb.g, rgb.b);
                        self.currentH = hsv.h;
                        self.currentS = hsv.s;
                        self.currentV = hsv.v;
                        self.updateEditorUI();
                        // Honor Shift on the Enter key as a one-shot stroke override
                        self.dragShiftActive = !!e.shiftKey;
                        self.updateEditorColor(true);
                        self.dragShiftActive = false;

                    } else {
                        showToast("Invalid HEX Format", "error");
                    }
                }
            });
        }
    },

    applyColor: function (colHex, target) {
        ToolBridge.call({
            key: "colorflow.apply",
            script: 'toolkitApplyColor("' + encodeBridge(colHex) + '", "' + encodeBridge(target) + '")',
            onResult: function (result) {
                if (result.status !== "success") return;
                var res = result.decoded;
                // Silent on success ("OK:..."). Surface only real errors.
                if (res.indexOf("OK:") !== 0 && res !== "true") {
                    showToast(res, "error");
                }
            }
        });
    },

    // Live-drag path: one host call per interval at most, plus a trailing
    // call so the color the drag ENDED on always lands in AE. The previous
    // behavior fired an evalScript on every mousemove.
    applyColorLive: function (colHex, target) {
        var self = this;
        this._livePending = { col: colHex, target: target };
        if (!this._liveLastAt || (Date.now() - this._liveLastAt) >= COLORFLOW_LIVE_INTERVAL_MS) {
            this._liveLastAt = Date.now();
            var pending = this._livePending;
            this._livePending = null;
            this.applyColor(pending.col, pending.target);
            return;
        }
        clearTimeout(this._liveTrailing);
        this._liveTrailing = setTimeout(function () {
            self._liveLastAt = Date.now();
            var p = self._livePending;
            self._livePending = null;
            if (p) self.applyColor(p.col, p.target);
        }, COLORFLOW_LIVE_INTERVAL_MS);
    },

    // Open the workshop modal. If forSwatchIndex is supplied, focus that swatch.
    // Used by the edit button (no arg) and by double-click on a strip swatch (with arg).
    // If shiftHeld is true, the workshop session uses stroke as the live target
    // for the lifetime of the session (cleared on cancel/confirm).
    openWorkshop: function (forSwatchIndex, shiftHeld) {
        var currentPalette = this.palettes[this.activePaletteIndex];
        if (!currentPalette) return;

        if (typeof forSwatchIndex === "number" && forSwatchIndex >= 0) {
            this.selectedSwatchIndex = forSwatchIndex;
        }
        if (this.selectedSwatchIndex === null || this.selectedSwatchIndex === undefined) {
            this.selectedSwatchIndex = 0;
        }

        // Snapshot for revert-on-cancel (single-source-of-truth)
        this.snapshot = {
            colors: [].concat(currentPalette.colors),
            selectedIndex: this.selectedSwatchIndex,
            target: this.activeColorTarget
        };
        this.modalPaletteColors = [].concat(currentPalette.colors);

        var col = this.modalPaletteColors[this.selectedSwatchIndex] || "#FF0055";

        var rgb = this.hexToRgb(col);
        var hsv = this.rgbToHsv(rgb.r, rgb.g, rgb.b);
        this.currentH = hsv.h;
        this.currentS = hsv.s;
        this.currentV = hsv.v;

        this.updateEditorUI();
        this.renderModalPalettesDropdown();
        this.renderModalSwatches();

        var defaultName = localStorage.getItem("cs_colorflow_default_palette_name") || "Neon Cyber";
        var isDefault = (currentPalette.name === defaultName);
        var defaultBtn = document.getElementById("btn-flow-modal-default");
        if (defaultBtn) defaultBtn.classList.toggle("active", isDefault);

        var modal = document.getElementById("flow-editor-modal");
        if (modal) {
            modal.classList.add("open");
            FocusTrap.activate(modal);
            this.editorOpen = true;
            // Set session-level Shift override; cleared on close (cancel/confirm)
            this.sessionShiftOverride = !!shiftHeld;
            this.dragShiftActive = false;
        }
    }
};
