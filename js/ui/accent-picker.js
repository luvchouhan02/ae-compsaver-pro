// ============================================================
// ui/accent-picker.js — Custom Adobe/Figma-style accent color picker
// ------------------------------------------------------------
// A token-driven floating popover (NOT the native <input type=color>) for
// choosing a custom accent: Saturation/Brightness square, hue slider, HEX
// input, live preview, and Reset/Apply/Cancel. Anchored below the clicked
// swatch with viewport collision handling, closes on outside-click/Escape,
// animates with transform+opacity, and traps focus via FocusTrap.
//
// This module ONLY provides the UI for picking a custom color. It does not
// change any Accent Theme logic — on Apply it calls the supplied onApply(hex)
// callback (settings-panel wires that to the existing Settings.set path).
//
// Depends on globals (browser): document, FocusTrap, and optionally Accent
// (for the default hex). CommonJS-exports the pure color helpers for tests.
// Loaded after focus-trap.js, before settings-panel.js.
// ============================================================

var AccentPicker = (function () {
    "use strict";

    var DEFAULT_HEX = "#7c3aed"; // CompSaver Purple brand color

    // ── Pure color helpers ────────────────────────────────────────
    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

    function normalizeHex(hex) {
        if (typeof hex !== "string") return null;
        var s = hex.trim().toLowerCase();
        var m3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
        if (m3) return "#" + m3[1] + m3[1] + m3[2] + m3[2] + m3[3] + m3[3];
        var m6 = /^#?([0-9a-f]{6})$/.exec(s);
        if (m6) return "#" + m6[1];
        return null;
    }

    function hexToRgb(hex) {
        var n = normalizeHex(hex) || "#000000";
        return {
            r: parseInt(n.slice(1, 3), 16),
            g: parseInt(n.slice(3, 5), 16),
            b: parseInt(n.slice(5, 7), 16)
        };
    }

    function toHex2(v) {
        var h = clamp(Math.round(v), 0, 255).toString(16);
        return h.length === 1 ? "0" + h : h;
    }

    function rgbToHex(r, g, b) { return "#" + toHex2(r) + toHex2(g) + toHex2(b); }

    function rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        var max = Math.max(r, g, b), min = Math.min(r, g, b);
        var d = max - min;
        var h = 0;
        if (d !== 0) {
            if (max === r) h = ((g - b) / d) % 6;
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
            if (h < 0) h += 360;
        }
        var s = max === 0 ? 0 : d / max;
        return { h: h, s: s, v: max };
    }

    function hsvToRgb(h, s, v) {
        var c = v * s;
        var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        var m = v - c;
        var r = 0, g = 0, b = 0;
        if (h < 60) { r = c; g = x; }
        else if (h < 120) { r = x; g = c; }
        else if (h < 180) { g = c; b = x; }
        else if (h < 240) { g = x; b = c; }
        else if (h < 300) { r = x; b = c; }
        else { r = c; b = x; }
        return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
    }

    function hsvToHex(h, s, v) {
        var rgb = hsvToRgb(h, s, v);
        return rgbToHex(rgb.r, rgb.g, rgb.b);
    }

    // ── Popover state (browser) ───────────────────────────────────
    var pop = null, els = null, anchorEl = null;
    var onApplyCb = null, onPreviewCb = null, onRevertCb = null;
    var hasApplied = false;
    var H = 210, S = 1, V = 1;
    var escHandler = null, outsideHandler = null, closeTimer = null;

    function _el(tag, cls, attrs) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (attrs) for (var k in attrs) { if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]); }
        return e;
    }

    function build() {
        pop = _el("div", "accent-pop", { role: "dialog", "aria-label": "Custom accent color", "aria-modal": "false" });

        var sv = _el("div", "accent-pop-sv");
        var svHandle = _el("div", "accent-pop-sv-handle");
        sv.appendChild(svHandle);

        var hue = _el("div", "accent-pop-hue");
        var hueHandle = _el("div", "accent-pop-hue-handle");
        hue.appendChild(hueHandle);

        var row = _el("div", "accent-pop-row");
        var preview = _el("div", "accent-pop-preview", { "aria-hidden": "true" });
        var hexWrap = _el("div", "accent-pop-hex");
        var hexHash = _el("span", "accent-pop-hex-hash"); hexHash.textContent = "#";
        var hexInput = _el("input", "accent-pop-hex-input", { type: "text", maxlength: "6", spellcheck: "false", "aria-label": "Hex color" });
        hexWrap.appendChild(hexHash); hexWrap.appendChild(hexInput);
        row.appendChild(preview); row.appendChild(hexWrap);

        var btns = _el("div", "accent-pop-btns");
        var btnReset = _el("button", "accent-pop-btn accent-pop-btn--ghost", { type: "button" });
        btnReset.textContent = "Reset";
        var btnCancel = _el("button", "accent-pop-btn accent-pop-btn--ghost", { type: "button" });
        btnCancel.textContent = "Cancel";
        var btnApply = _el("button", "accent-pop-btn accent-pop-btn--primary", { type: "button" });
        btnApply.textContent = "Apply";
        btns.appendChild(btnReset); btns.appendChild(btnCancel); btns.appendChild(btnApply);

        pop.appendChild(sv); pop.appendChild(hue); pop.appendChild(row); pop.appendChild(btns);

        els = {
            sv: sv, svHandle: svHandle, hue: hue, hueHandle: hueHandle,
            preview: preview, hexInput: hexInput,
            btnReset: btnReset, btnCancel: btnCancel, btnApply: btnApply
        };

        _bindSquare();
        _bindHue();
        _bindHex();
        btnReset.addEventListener("click", function () { setFromHex(DEFAULT_HEX); els.hexInput.focus(); });
        btnCancel.addEventListener("click", function () { close(); });
        btnApply.addEventListener("click", function () {
            var hex = hsvToHex(H, S, V);
            hasApplied = true;
            if (typeof onApplyCb === "function") onApplyCb(hex);
            close();
        });
    }

    function _pointer(e, axis) {
        if (e.touches && e.touches.length > 0) return axis === "x" ? e.touches[0].clientX : e.touches[0].clientY;
        return axis === "x" ? e.clientX : e.clientY;
    }

    function _bindSquare() {
        var dragging = false;
        function move(e) {
            var rect = els.sv.getBoundingClientRect();
            var x = clamp(_pointer(e, "x") - rect.left, 0, rect.width);
            var y = clamp(_pointer(e, "y") - rect.top, 0, rect.height);
            S = rect.width ? x / rect.width : 0;
            V = rect.height ? 1 - y / rect.height : 0;
            render();
            if (e.cancelable) e.preventDefault();
        }
        function up() { dragging = false; document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); }
        els.sv.addEventListener("mousedown", function (e) {
            dragging = true; move(e);
            document.addEventListener("mousemove", move);
            document.addEventListener("mouseup", up);
        });
    }

    function _bindHue() {
        function move(e) {
            var rect = els.hue.getBoundingClientRect();
            var x = clamp(_pointer(e, "x") - rect.left, 0, rect.width);
            H = rect.width ? (x / rect.width) * 360 : 0;
            render();
            if (e.cancelable) e.preventDefault();
        }
        function up() { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); }
        els.hue.addEventListener("mousedown", function (e) {
            move(e);
            document.addEventListener("mousemove", move);
            document.addEventListener("mouseup", up);
        });
    }

    function _bindHex() {
        els.hexInput.addEventListener("input", function () {
            var n = normalizeHex(this.value);
            if (!n) return;
            var rgb = hexToRgb(n);
            var hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
            H = hsv.h; S = hsv.s; V = hsv.v;
            render(true); // skip rewriting the field the user is editing
        });
    }

    function setFromHex(hex) {
        var n = normalizeHex(hex) || DEFAULT_HEX;
        var rgb = hexToRgb(n);
        var hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
        H = hsv.h; S = hsv.s; V = hsv.v;
        render();
    }

    function render(skipHexField) {
        if (!els) return;
        var hueHex = hsvToHex(H, 1, 1);
        els.sv.style.backgroundColor = hueHex;
        els.svHandle.style.left = (S * 100) + "%";
        els.svHandle.style.top = ((1 - V) * 100) + "%";
        els.hueHandle.style.left = ((H / 360) * 100) + "%";
        var hex = hsvToHex(H, S, V);
        els.preview.style.backgroundColor = hex;
        if (!skipHexField) els.hexInput.value = hex.slice(1);
        
        // Live preview hook
        if (typeof onPreviewCb === "function") onPreviewCb(hex);
    }

    function position(anchor) {
        var margin = 8;
        var rect = anchor.getBoundingClientRect();
        // measure rendered size
        var pw = pop.offsetWidth || 240;
        var ph = pop.offsetHeight || 240;
        var vw = window.innerWidth, vh = window.innerHeight;

        var left = rect.left;
        if (left + pw > vw - margin) left = vw - margin - pw;
        if (left < margin) left = margin;

        var top = rect.bottom + 6;
        if (top + ph > vh - margin) {
            var above = rect.top - 6 - ph;
            top = above >= margin ? above : Math.max(margin, vh - margin - ph);
        }
        pop.style.left = Math.round(left) + "px";
        pop.style.top = Math.round(top) + "px";
    }

    function _reposition() {
        if (pop && anchorEl) position(anchorEl);
    }

    function _bindDismiss() {
        window.addEventListener("resize", _reposition);
        escHandler = function (e) {
            if (e.key === "Escape" || e.keyCode === 27) { e.stopPropagation(); close(); }
        };
        outsideHandler = function (e) {
            if (!pop) return;
            if (pop.contains(e.target)) return;
            if (anchorEl && anchorEl.contains(e.target)) return;
            close();
        };
        document.addEventListener("keydown", escHandler, true);
        // defer so the opening click doesn't immediately close it
        setTimeout(function () { document.addEventListener("mousedown", outsideHandler, true); }, 0);
    }

    function _unbindDismiss() {
        window.removeEventListener("resize", _reposition);
        if (escHandler) document.removeEventListener("keydown", escHandler, true);
        if (outsideHandler) document.removeEventListener("mousedown", outsideHandler, true);
        escHandler = null; outsideHandler = null;
    }

    /**
     * Open the picker anchored to `anchor`.
     * @param {HTMLElement} anchor - swatch button the popover anchors below
     * @param {{initialHex?:string, onApply?:function(string), onPreview?:function(string), onRevert?:function()}} opts
     */
    function open(anchor, opts) {
        opts = opts || {};
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        if (!pop) build();
        if (!pop.parentNode) document.body.appendChild(pop);
        anchorEl = anchor || null;
        onApplyCb = opts.onApply || null;
        onPreviewCb = opts.onPreview || null;
        onRevertCb = opts.onRevert || null;
        hasApplied = false;

        // Make measurable (rendered, not yet animated in)
        pop.style.visibility = "hidden";
        pop.classList.remove("open");
        pop.style.display = "block";
        setFromHex(opts.initialHex || DEFAULT_HEX);
        position(anchor);
        pop.style.visibility = "";

        // animate in (transform + opacity) on next frame
        void pop.offsetWidth;
        requestAnimationFrame(function () { if (pop) pop.classList.add("open"); });

        _bindDismiss();
        if (typeof FocusTrap !== "undefined" && FocusTrap.activate) FocusTrap.activate(pop, anchor);
    }

    function close() {
        if (!pop) return;
        _unbindDismiss();
        if (typeof FocusTrap !== "undefined" && FocusTrap.deactivate) FocusTrap.deactivate();
        pop.classList.remove("open");
        
        // Cancel/Revert if not explicitly applied
        if (!hasApplied && typeof onRevertCb === "function") {
            onRevertCb();
        }
        
        // hide after the close transition (kept in DOM for reuse)
        closeTimer = setTimeout(function () {
            if (pop && !pop.classList.contains("open")) pop.style.display = "none";
            closeTimer = null;
        }, 220);
    }

    function isOpen() { return !!(pop && pop.classList.contains("open")); }

    return {
        open: open,
        close: close,
        isOpen: isOpen,
        // pure helpers (exported for tests)
        normalizeHex: normalizeHex,
        hexToRgb: hexToRgb,
        rgbToHex: rgbToHex,
        rgbToHsv: rgbToHsv,
        hsvToRgb: hsvToRgb,
        hsvToHex: hsvToHex
    };
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = AccentPicker;
}
