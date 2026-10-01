/* Foldframe component DOM contracts — Task 2.3. Classic-script/ES5 compatible. */
var CompSaverComponents = (function () {
    "use strict";

    var contracts = {
        button: { rootClass: "cs-btn", element: "button", states: ["idle", "hover", "active", "focus", "disabled", "busy", "success", "warning", "error"] },
        field: { rootClass: "cs-field", controlClass: "cs-field__control", descriptionAttribute: "aria-describedby" },
        select: { rootClass: "cs-select", controlClass: "cs-select__control" },
        toggle: { rootClass: "cs-toggle", role: "switch", stateAttribute: "aria-checked" },
        slider: { rootClass: "cs-slider", controlRole: "slider", stateAttribute: "aria-valuenow" },
        segmented: { rootClass: "cs-segmented", role: "radiogroup", itemClass: "cs-segment" },
        tabs: { rootClass: "cs-tabs", role: "tablist", itemClass: "cs-tab" },
        chip: { rootClass: "cs-chip", stateAttribute: "aria-pressed" },
        card: { rootClass: "cs-card", role: "article", actionClass: "cs-card__actions" },
        badge: { rootClass: "cs-badge", stateAttribute: "data-state" },
        menu: { rootClass: "cs-menu", role: "menu", itemClass: "cs-menu__item" },
        dialog: { rootClass: "cs-dialog", role: "dialog", nameAttribute: "aria-labelledby" },
        toast: { rootClass: "cs-toast", role: "status", stateAttribute: "data-state" },
        tooltip: { rootClass: "cs-tooltip", role: "tooltip", triggerAttribute: "aria-describedby" },
        placeholder: { rootClass: "cs-placeholder", stateAttribute: "aria-busy" },
        state: { rootClass: "cs-state", role: "status", actionClass: "cs-state__actions" }
    };
    var componentNames = ["button", "field", "select", "toggle", "slider", "segmented", "tabs", "chip", "card", "badge", "menu", "dialog", "toast", "tooltip", "placeholder", "state"];

    function copy(value) {
        var result = {}, key;
        for (key in value) if (value.hasOwnProperty(key)) {
            result[key] = value[key] && value[key].slice ? value[key].slice(0) : value[key];
        }
        return result;
    }
    function contractFor(name) { return contracts[name] ? copy(contracts[name]) : null; }
    function names() { return componentNames.slice(0); }
    function getAttribute(node, name) { return node && node.getAttribute ? node.getAttribute(name) : null; }
    function setAttribute(node, name, value) { if (node && node.setAttribute) node.setAttribute(name, String(value)); }
    function removeAttribute(node, name) { if (node && node.removeAttribute) node.removeAttribute(name); }
    function trim(value) { return String(value || "").replace(/^\s+|\s+$/g, ""); }

    function addClass(node, name) {
        if (!node) return;
        if (node.classList && node.classList.add) node.classList.add(name);
        else if (!(new RegExp("(^|\\s)" + name + "(\\s|$)")).test(node.className || "")) node.className = trim((node.className || "") + " " + name);
    }
    function removeClass(node, name) {
        if (!node) return;
        if (node.classList && node.classList.remove) node.classList.remove(name);
        else node.className = trim(String(node.className || "").replace(new RegExp("(^|\\s)" + name + "(?=\\s|$)", "g"), " ").replace(/\s+/g, " "));
    }
    function nodeText(node) { return trim(node && (node.textContent || node.innerText)); }
    function labelledByText(node) {
        var id = getAttribute(node, "aria-labelledby"), doc, label;
        if (!id) return "";
        doc = node.ownerDocument;
        label = doc && doc.getElementById ? doc.getElementById(id) : null;
        return nodeText(label);
    }
    function accessibleName(node) { return trim(getAttribute(node, "aria-label")) || labelledByText(node) || nodeText(node); }
    function decorateIconButton(control, label) {
        label = trim(label);
        if (!control) throw new Error("ICON_BUTTON_CONTROL_REQUIRED");
        if (!label) throw new Error("ICON_BUTTON_ACCESSIBLE_NAME_REQUIRED");
        addClass(control, "cs-btn");
        addClass(control, "cs-btn--icon");
        setAttribute(control, "type", "button");
        setAttribute(control, "data-icon-only", "true");
        setAttribute(control, "aria-label", label);
        return control;
    }

    function setBusy(control, busy) {
        var name, wasDisabled;
        if (!control) throw new Error("BUSY_CONTROL_REQUIRED");
        if (busy === true) {
            name = accessibleName(control);
            if (!name) throw new Error("BUSY_CONTROL_ACCESSIBLE_NAME_REQUIRED");
            setAttribute(control, "data-busy-accessible-name", name);
            setAttribute(control, "aria-busy", "true");
            setAttribute(control, "data-state", "busy");
            wasDisabled = control.disabled === true || getAttribute(control, "aria-disabled") === "true";
            setAttribute(control, "data-busy-was-disabled", wasDisabled ? "true" : "false");
            if (typeof control.disabled === "boolean") control.disabled = true;
            else setAttribute(control, "aria-disabled", "true");
        } else {
            wasDisabled = getAttribute(control, "data-busy-was-disabled") === "true";
            removeAttribute(control, "aria-busy");
            removeAttribute(control, "data-state");
            removeAttribute(control, "data-busy-accessible-name");
            removeAttribute(control, "data-busy-was-disabled");
            if (typeof control.disabled === "boolean") control.disabled = wasDisabled;
            else if (!wasDisabled) removeAttribute(control, "aria-disabled");
        }
        return control;
    }

    function contains(region, control) {
        if (!region || !control) return false;
        if (region === control) return true;
        return region.contains ? region.contains(control) : true;
    }
    function queryAll(root, selector) {
        var result = [], list, i;
        if (!root || !root.querySelectorAll) return result;
        list = root.querySelectorAll(selector);
        for (i = 0; i < list.length; i++) result.push(list[i]);
        return result;
    }
    function makeSecondary(control) {
        removeClass(control, "cs-btn--primary");
        addClass(control, "cs-btn--secondary");
        setAttribute(control, "data-variant", "secondary");
        removeAttribute(control, "data-primary-action");
    }
    function setPrimaryAction(region, control) {
        var existing, i;
        if (!region || !control || !contains(region, control)) throw new Error("PRIMARY_ACTION_REGION_MISMATCH");
        setAttribute(region, "data-task-region", getAttribute(region, "data-task-region") || "task");
        addClass(region, "cs-action-region");
        existing = queryAll(region, ".cs-btn--primary, .cs-btn[data-variant=\"primary\"], .cs-btn[data-primary-action=\"true\"]");
        for (i = 0; i < existing.length; i++) if (existing[i] !== control) makeSecondary(existing[i]);
        removeClass(control, "cs-btn--secondary");
        addClass(control, "cs-btn");
        addClass(control, "cs-btn--primary");
        setAttribute(control, "data-variant", "primary");
        setAttribute(control, "data-primary-action", "true");
        return control;
    }

    function setPressed(control, pressed) {
        if (!control) throw new Error("PRESSABLE_CONTROL_REQUIRED");
        setAttribute(control, "aria-pressed", pressed === true ? "true" : "false");
        return control;
    }
    function setSelected(control, selected) {
        if (!control) throw new Error("SELECTABLE_CONTROL_REQUIRED");
        setAttribute(control, "aria-selected", selected === true ? "true" : "false");
        return control;
    }
    function validate(root) {
        var errors = [], regions, iconButtons, busyControls, stateControls, i, primary, name, retainedName;
        if (!root || !root.querySelectorAll) return { ok: false, errors: ["ROOT_QUERY_API_REQUIRED"] };
        regions = queryAll(root, "[data-task-region]");
        for (i = 0; i < regions.length; i++) {
            primary = queryAll(regions[i], ".cs-btn[data-primary-action=\"true\"]");
            if (primary.length > 1) errors.push("MULTIPLE_PRIMARY_ACTIONS");
        }
        iconButtons = queryAll(root, ".cs-btn--icon, [data-icon-only=\"true\"]");
        for (i = 0; i < iconButtons.length; i++) if (!accessibleName(iconButtons[i])) errors.push("ICON_BUTTON_ACCESSIBLE_NAME_REQUIRED");
        busyControls = queryAll(root, "[aria-busy=\"true\"]");
        for (i = 0; i < busyControls.length; i++) {
            name = accessibleName(busyControls[i]);
            retainedName = trim(getAttribute(busyControls[i], "data-busy-accessible-name"));
            if (!name) errors.push("BUSY_CONTROL_ACCESSIBLE_NAME_REQUIRED");
            if (!retainedName || retainedName !== name) errors.push("BUSY_CONTROL_NAME_NOT_RETAINED");
        }
        stateControls = queryAll(root, "[data-favorite], .cs-chip, .cs-segment, .cs-tab, .cs-toggle");
        for (i = 0; i < stateControls.length; i++) {
            if ((new RegExp("(^|\\s)cs-toggle(\\s|$)")).test(stateControls[i].className || "") && getAttribute(stateControls[i], "aria-checked") === null) errors.push("TOGGLE_STATE_REQUIRED");
            if ((new RegExp("(^|\\s)cs-tab(\\s|$)")).test(stateControls[i].className || "") && getAttribute(stateControls[i], "aria-selected") === null) errors.push("TAB_STATE_REQUIRED");
            if (getAttribute(stateControls[i], "data-favorite") !== null && getAttribute(stateControls[i], "aria-pressed") === null) errors.push("FAVORITE_STATE_REQUIRED");
        }
        return { ok: errors.length === 0, errors: errors };
    }

    function assertValid(root) {
        var result = validate(root);
        if (!result.ok) throw new Error(result.errors.join(","));
        return result;
    }

    return {
        version: "foldframe-components-1",
        names: names,
        contractFor: contractFor,
        accessibleName: accessibleName,
        decorateIconButton: decorateIconButton,
        setBusy: setBusy,
        setPrimaryAction: setPrimaryAction,
        setPressed: setPressed,
        setSelected: setSelected,
        validate: validate,
        assertValid: assertValid
    };
}());

if (typeof module !== "undefined" && module.exports) module.exports = CompSaverComponents;
