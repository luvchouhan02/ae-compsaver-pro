// ============================================================
// ui/focus-trap.js — Modal focus trapping utility
// ------------------------------------------------------------
// Provides FocusTrap.activate(modal, trigger) and FocusTrap.deactivate()
// to keep Tab cycling within an open modal and return focus to the
// trigger element on close. Loaded before modals.js / templates.js.
// Requirements: 7.3, 12.3
// ============================================================

var FocusTrap = (function () {
    "use strict";

    var _activeModal = null;
    var _triggerElement = null;
    var _keyHandler = null;

    var FOCUSABLE_SELECTOR =
        'a[href], button:not([disabled]), input:not([disabled]), ' +
        'select:not([disabled]), textarea:not([disabled]), ' +
        '[tabindex]:not([tabindex="-1"])';

    function getFocusableElements(container) {
        var elements = container.querySelectorAll(FOCUSABLE_SELECTOR);
        var visible = [];
        for (var i = 0; i < elements.length; i++) {
            var el = elements[i];
            // Skip elements that are not visible/rendered
            if (el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0) {
                visible.push(el);
            }
        }
        return visible;
    }

    function handleKeyDown(e) {
        if (!_activeModal) return;

        if (e.key === "Tab") {
            var focusable = getFocusableElements(_activeModal);
            if (focusable.length === 0) {
                e.preventDefault();
                return;
            }

            var first = focusable[0];
            var last = focusable[focusable.length - 1];
            var active = document.activeElement;

            if (e.shiftKey) {
                // Shift+Tab: if on first element or outside modal, wrap to last
                if (active === first || !_activeModal.contains(active)) {
                    e.preventDefault();
                    last.focus();
                }
            } else {
                // Tab: if on last element or outside modal, wrap to first
                if (active === last || !_activeModal.contains(active)) {
                    e.preventDefault();
                    first.focus();
                }
            }
        }
    }

    /**
     * Activate focus trapping within a modal element.
     * @param {HTMLElement} modal - The modal container element
     * @param {HTMLElement} [trigger] - Element that opened the modal (focus returns here on close)
     */
    function activate(modal, trigger) {
        if (!modal) return;

        // Deactivate any previous trap first
        if (_activeModal) deactivate();

        _activeModal = modal;
        _triggerElement = trigger || document.activeElement;

        _keyHandler = handleKeyDown;
        document.addEventListener("keydown", _keyHandler, true);

        // Move focus into the modal after a brief delay (allows modal to render)
        setTimeout(function () {
            if (!_activeModal) return;
            var focusable = getFocusableElements(_activeModal);
            if (focusable.length > 0) {
                // Only move focus if it's not already inside the modal
                if (!_activeModal.contains(document.activeElement)) {
                    focusable[0].focus();
                }
            }
        }, 50);
    }

    /**
     * Deactivate focus trapping and return focus to the trigger element.
     */
    function deactivate() {
        if (_keyHandler) {
            document.removeEventListener("keydown", _keyHandler, true);
            _keyHandler = null;
        }

        var trigger = _triggerElement;
        _activeModal = null;
        _triggerElement = null;

        // Return focus to the element that triggered the modal
        if (trigger && trigger.focus) {
            try { trigger.focus(); } catch (e) { /* element may have been removed */ }
        }
    }

    /**
     * Check if a focus trap is currently active.
     * @returns {boolean}
     */
    function isActive() {
        return !!_activeModal;
    }

    return {
        activate: activate,
        deactivate: deactivate,
        isActive: isActive,
        getActive: function () { return _activeModal; }
    };
})();
