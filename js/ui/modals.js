// ============================================================
// ui/modals.js - save-type picker + category/move select helpers
// ------------------------------------------------------------
// Save-type labels/section/title resolvers, the save-type picker wiring,
// the custom category <select> and move-category <select> builders, and
// applyWallLogic / rebuildSaveModalCategories. Depends on globals: DOM,
// showToast, SECTIONS, getTemplateSection, currentSection, selectedSaveType,
// selectedCatValue, selectedMoveCat, saveCapabilities, allTemplates.
// init() calls initSaveTypePicker/initCustomSelect/initMoveSelect.
// Loaded before main.js.
// ============================================================

    function getSaveTypeLabel(type) {
        var labels = {
            comp: "Pre-Comp",
            png: "PNG",
            layer: "Layer",
            text: "Text Layer",
            text_props: "Text Properties",
            footage: "Footage",
            effect: "Effect Preset"
        };
        return labels[type] || "Template";
    }

    function getSaveSectionForType(type) {
        if (type === SECTIONS.COMP) return SECTIONS.COMP;
        if (type === SECTIONS.LAYER) return SECTIONS.LAYER;
        if (type === SECTIONS.TEXT) return SECTIONS.TEXT;
        if (type === SECTIONS.TEXT_PROPS) return SECTIONS.TEXT_PROPS;
        if (type === SECTIONS.FOOTAGE) return SECTIONS.FOOTAGE;
        if (type === SECTIONS.EFFECT) return SECTIONS.EFFECT;
        if (type === "png") {
            if (currentSection === SECTIONS.OVERLAY) return SECTIONS.OVERLAY;
            return SECTIONS.ICON;
        }
        return currentSection;
    }

    function getSaveModalTitle(type) {
        var titles = {
            comp: "Pre-Comp Save",
            png: "PNG Save",
            layer: "Layer Save",
            text: "Text Layer Save",
            text_props: "Text Properties Save",
            footage: "Footage Save",
            effect: "Effect Preset Save"
        };
        return titles[type] || "Template Save";
    }

    function setSaveType(type) {
        selectedSaveType = type;
        var btns = document.querySelectorAll(".save-type-btn");
        for (var i = 0; i < btns.length; i++) {
            var btnType = btns[i].dataset.saveType;
            btns[i].classList.toggle(
                "active",
                btnType === type || (btnType === SECTIONS.TEXT && type === SECTIONS.TEXT_PROPS)
            );
        }
        rebuildSaveModalCategories(type);
    }

    function applyWallLogic() {
        var btns = document.querySelectorAll(".save-type-btn");
        if (!saveCapabilities) {
            for (var i = 0; i < btns.length; i++) {
                btns[i].disabled = false;
                btns[i].style.opacity = "1";
                btns[i].style.cursor = "pointer";
            }
            return;
        }
        var caps = saveCapabilities;
        for (var j = 0; j < btns.length; j++) {
            var btn = btns[j];
            var btnType = btn.dataset.saveType;
            var enabled = false;
            if (btnType === "comp" && caps.comp) enabled = true;
            if (btnType === "layer" && caps.layer) enabled = true;
            if (btnType === "text" && caps.text) enabled = true;
            if (btnType === "footage" && caps.footage) enabled = true;
            if (btnType === "png" && caps.png) enabled = true;
            if (btnType === "effect" && caps.effect) enabled = true;
            btn.disabled = !enabled;
            btn.style.opacity = enabled ? "1" : "0.3";
            btn.style.cursor = enabled ? "pointer" : "not-allowed";
        }
    }

    function rebuildSaveModalCategories(type) {
        var sectionType = getSaveSectionForType(type);
        var sectionTemplates = [];
        for (var i = 0; i < allTemplates.length; i++) {
            if (getTemplateSection(allTemplates[i]) === sectionType) {
                sectionTemplates.push(allTemplates[i]);
            }
        }

        var cats = ["Uncategorized"];
        for (var k = 0; k < sectionTemplates.length; k++) {
            var t = sectionTemplates[k];
            if (t.category && t.category !== "All" && t.category !== "Favorites" &&
                cats.indexOf(t.category) === -1) {
                cats.push(t.category);
            }
        }

        var prevValue = selectedCatValue || "Uncategorized";
        updateCustomSelect(cats);

        if (cats.indexOf(prevValue) !== -1) {
            selectedCatValue = prevValue;
            if (DOM["cat-select-value"]) DOM["cat-select-value"].textContent = prevValue;
            if (DOM["modal-cat-select"]) DOM["modal-cat-select"].value = prevValue;
            var dropdown = DOM["cat-select-dropdown"];
            if (dropdown) {
                var opts = dropdown.querySelectorAll(".custom-select-option");
                for (var m = 0; m < opts.length; m++) {
                    opts[m].classList.toggle("active", opts[m].textContent === prevValue);
                }
            }
        }

        if (DOM["save-modal-title"]) {
            DOM["save-modal-title"].textContent = getSaveModalTitle(type);
        }
    }

    function initSaveTypePicker() {
        var btns = document.querySelectorAll(".save-type-btn");
        for (var i = 0; i < btns.length; i++) {
            btns[i].addEventListener("click", function (e) {
                e.stopPropagation();
                if (this.disabled) {
                    showToast("Save type locked. Selection doesn't match.", "error");
                    return;
                }
                var chosenType = this.dataset.saveType;
                if (chosenType === SECTIONS.TEXT && currentSection === SECTIONS.TEXT_PROPS) {
                    chosenType = SECTIONS.TEXT_PROPS;
                }
                setSaveType(chosenType);
            });
        }
    }

    function setCategorySelectOpen(wrapper, open) {
        if (!wrapper) return;
        wrapper.classList.toggle("open", open);
        var trigger = wrapper.querySelector(".custom-select-trigger");
        if (trigger) trigger.setAttribute("aria-expanded", open ? "true" : "false");
    }

    function bindCategorySelect(trigger, wrapper) {
        if (!trigger || !wrapper) return;
        trigger.addEventListener("click", function (e) {
            e.stopPropagation();
            var open = !wrapper.classList.contains("open");
            setCategorySelectOpen(DOM["cat-select-wrapper"], false);
            setCategorySelectOpen(DOM["move-cat-select-wrapper"], false);
            setCategorySelectOpen(wrapper, open);
        });
        wrapper.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && wrapper.classList.contains("open")) {
                e.preventDefault();
                e.stopPropagation();
                setCategorySelectOpen(wrapper, false);
                trigger.focus();
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                var options = wrapper.querySelectorAll(".custom-select-option");
                if (!options.length) return;
                e.preventDefault();
                setCategorySelectOpen(wrapper, true);
                var index = Array.prototype.indexOf.call(options, e.target);
                var next = index < 0 ? (e.key === "ArrowDown" ? 0 : options.length - 1) :
                    (index + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
                options[next].focus();
            }
        });
    }

    function initCustomSelect() {
        var trigger = DOM["cat-select-trigger"];
        var wrapper = DOM["cat-select-wrapper"];
        if (!trigger || !wrapper) return;
        bindCategorySelect(trigger, wrapper);

        document.addEventListener("click", function (e) {
            if (!wrapper.contains(e.target)) setCategorySelectOpen(wrapper, false);
            var mw = DOM["move-cat-select-wrapper"];
            if (mw && !mw.contains(e.target)) setCategorySelectOpen(mw, false);
        });
    }

    function updateCustomSelect(categories) {
        var dropdown = DOM["cat-select-dropdown"];
        var valueSpan = DOM["cat-select-value"];
        var hiddenSelect = DOM["modal-cat-select"];
        if (!dropdown || !valueSpan || !hiddenSelect) return;

        var cats = ["Uncategorized"];
        for (var i = 0; i < categories.length; i++) {
            var c = categories[i];
            if (c !== "All" && c !== "Favorites" && c !== "Uncategorized") cats.push(c);
        }

        dropdown.innerHTML = "";
        hiddenSelect.innerHTML = "";
        selectedCatValue = "Uncategorized";
        valueSpan.textContent = "Uncategorized";

        for (var j = 0; j < cats.length; j++) {
            (function (cat) {
                var opt = document.createElement("button");
                opt.type = "button";
                opt.className = "custom-select-option" + (cat === selectedCatValue ? " active" : "");
                opt.textContent = cat;
                opt.addEventListener("click", function (e) {
                    e.stopPropagation();
                    selectedCatValue = cat;
                    valueSpan.textContent = cat;
                    var opts = dropdown.querySelectorAll(".custom-select-option");
                    for (var k = 0; k < opts.length; k++) opts[k].classList.remove("active");
                    opt.classList.add("active");
                    hiddenSelect.value = cat;
                    setCategorySelectOpen(DOM["cat-select-wrapper"], false);
                    DOM["cat-select-trigger"].focus();
                });
                dropdown.appendChild(opt);

                var s = document.createElement("option");
                s.value = cat;
                s.textContent = cat;
                hiddenSelect.appendChild(s);
            })(cats[j]);
        }
    }

    function initMoveSelect() {
        var trigger = DOM["move-cat-select-trigger"];
        var wrapper = DOM["move-cat-select-wrapper"];
        bindCategorySelect(trigger, wrapper);
    }

    function updateMoveSelect(categories, currentCat) {
        var dropdown = DOM["move-cat-select-dropdown"];
        var valueSpan = DOM["move-cat-select-value"];
        if (!dropdown || !valueSpan) return;

        var cats = [];
        for (var i = 0; i < categories.length; i++) {
            var c = categories[i];
            if (c !== currentCat && c !== "All" && c !== "Favorites") cats.push(c);
        }

        dropdown.innerHTML = "";
        selectedMoveCat = cats.length > 0 ? cats[0] : "";
        valueSpan.textContent = selectedMoveCat || "No other categories";

        for (var j = 0; j < cats.length; j++) {
            (function (cat) {
                var opt = document.createElement("button");
                opt.type = "button";
                opt.className = "custom-select-option" + (cat === selectedMoveCat ? " active" : "");
                opt.textContent = cat;
                opt.addEventListener("click", function (e) {
                    e.stopPropagation();
                    selectedMoveCat = cat;
                    valueSpan.textContent = cat;
                    var opts = dropdown.querySelectorAll(".custom-select-option");
                    for (var k = 0; k < opts.length; k++) opts[k].classList.remove("active");
                    opt.classList.add("active");
                    setCategorySelectOpen(DOM["move-cat-select-wrapper"], false);
                    DOM["move-cat-select-trigger"].focus();
                });
                dropdown.appendChild(opt);
            })(cats[j]);
        }
    }
