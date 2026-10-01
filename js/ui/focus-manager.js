// ============================================================
// ui/focus-manager.js - keyboard modality, CEP key registration,
// focus recovery and Enter/Space on non-native buttons (Req 9.4, 16.1,
// 18.1, 18.7, 18.8, 18.9)
// ------------------------------------------------------------
// CEP hands key presses to After Effects unless the panel registered
// them with CSInterface.registerKeyEventsInterest. The key set follows
// the input modality so a pointer user's Space still starts a preview:
//   base      - Ctrl/Cmd+K, Tab, Shift+Tab, Escape (whole session)
//   keyboard  - base + Enter, Space, Shift+Enter, Shift+Space, arrows
//   composite - base + arrows (pointer focus on role=tab / role=radio)
// No DOM or Host access at load time.
// ============================================================
(function (root) {
    "use strict";

    var SETS = ["base", "keyboard", "composite"];

    // Virtual key codes per platform.
    var CODES = {
        win: { tab: 9, enter: [13], escape: 27, space: 32, left: 37, up: 38, right: 39, down: 40, k: 75, mod: "ctrlKey" },
        mac: { tab: 48, enter: [36, 76], escape: 53, space: 49, left: 123, right: 124, down: 125, up: 126, k: 40, mod: "metaKey" }
    };

    function normalizePlatform(platform) {
        return platform === "mac" ? "mac" : "win";
    }

    /** Pure: the JSON string for registerKeyEventsInterest for one key set. */
    function keyInterestFor(set, platform) {
        var c = CODES[normalizePlatform(platform)];
        var list = [];
        var hot = { keyCode: c.k };
        hot[c.mod] = true;
        list.push(hot);
        list.push({ keyCode: c.tab });
        list.push({ keyCode: c.tab, shiftKey: true });
        list.push({ keyCode: c.escape });
        if (set === "keyboard") {
            for (var i = 0; i < c.enter.length; i++) {
                list.push({ keyCode: c.enter[i] });
                list.push({ keyCode: c.enter[i], shiftKey: true });
            }
            list.push({ keyCode: c.space });
            list.push({ keyCode: c.space, shiftKey: true });
        }
        if (set === "keyboard" || set === "composite") {
            list.push({ keyCode: c.left });
            list.push({ keyCode: c.right });
            list.push({ keyCode: c.up });
            list.push({ keyCode: c.down });
        }
        return JSON.stringify(list);
    }

    function isNativeActivatable(el) {
        var tag = el && el.tagName ? String(el.tagName).toUpperCase() : "";
        return tag === "BUTTON" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "A" || tag === "SUMMARY";
    }

    function createFocusManager() {
        var deps = {};
        var currentSet = null;
        var modality = "pointer";
        var lastFocused = null;
        var initialized = false;
        var motionListeners = [];
        var motionMql = null;
        var checkScheduled = false;

        function doc() { return deps.doc || (typeof document !== "undefined" ? document : null); }
        function win() { return deps.win || (typeof window !== "undefined" ? window : null); }
        function cs() {
            if (deps.csInterface) return deps.csInterface;
            if (typeof root.csInterface !== "undefined" && root.csInterface) return root.csInterface;
            return null;
        }
        function platform() {
            if (deps.platform) return normalizePlatform(deps.platform);
            var nav = typeof navigator !== "undefined" ? navigator : null;
            var p = nav && (nav.platform || nav.userAgent) ? String(nav.platform || nav.userAgent) : "";
            return /mac/i.test(p) ? "mac" : "win";
        }
        function later(fn) { (deps.setTimeout || setTimeout)(fn, 0); }
        function matchMediaFn() {
            if (deps.matchMedia) return deps.matchMedia;
            var w = win();
            return w && typeof w.matchMedia === "function" ? w.matchMedia.bind(w) : null;
        }

        function register(set) {
            if (set === currentSet) return false;
            currentSet = set;
            var c = cs();
            if (c && typeof c.registerKeyEventsInterest === "function") {
                try { c.registerKeyEventsInterest(keyInterestFor(set, platform())); } catch (e) { /* host without key API */ }
            }
            return true;
        }

        function roleOf(el) {
            return el && typeof el.getAttribute === "function" ? el.getAttribute("role") : null;
        }

        function setKeyboardModality() {
            modality = "keyboard";
            register("keyboard");
        }

        function setPointerModality(target) {
            modality = "pointer";
            var role = roleOf(target);
            register(role === "tab" || role === "radio" ? "composite" : "base");
        }

        function onKeyDown(e) {
            if (!e) return;
            if (e.key === "Tab") setKeyboardModality();
            else if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K" || e.code === "KeyK")) setKeyboardModality();
            if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
                var t = e.target;
                if (t && roleOf(t) === "button" && !isNativeActivatable(t)) {
                    if (e.key === "Enter") {
                        if (typeof t.click === "function") t.click();
                        if (typeof e.preventDefault === "function") e.preventDefault();
                    } else if (typeof e.preventDefault === "function") {
                        e.preventDefault();
                    }
                }
            }
        }

        function onKeyUp(e) {
            if (!e || (e.key !== " " && e.key !== "Spacebar")) return;
            var t = e.target;
            if (t && roleOf(t) === "button" && !isNativeActivatable(t) && typeof t.click === "function") {
                if (typeof e.preventDefault === "function") e.preventDefault();
                t.click();
            }
        }

        function onFocusIn(e) {
            var t = e && e.target;
            var d = doc();
            if (t && (!d || t !== d.body)) lastFocused = t;
            if (modality === "pointer") {
                var role = roleOf(t);
                register(role === "tab" || role === "radio" ? "composite" : "base");
            }
        }

        function onFocusOut(e) {
            if (e && e.relatedTarget === null) check("focusout");
        }

        function init(options) {
            if (options) configure(options);
            register("base");
            if (initialized) return api;
            initialized = true;
            var d = doc();
            var w = win();
            if (d && typeof d.addEventListener === "function") {
                d.addEventListener("keydown", onKeyDown, true);
                d.addEventListener("keyup", onKeyUp, true);
                d.addEventListener("pointerdown", function (e) { setPointerModality(e && e.target); }, true);
                d.addEventListener("focusin", onFocusIn, true);
                d.addEventListener("focusout", onFocusOut, true);
            }
            if (w && typeof w.addEventListener === "function") {
                w.addEventListener("blur", function () { modality = "pointer"; register("base"); });
            }
            return api;
        }

        function configure(options) {
            options = options || {};
            var keys = ["doc", "win", "csInterface", "platform", "setTimeout", "matchMedia", "sidebar", "palette", "focusTrap", "getComputedStyle"];
            for (var i = 0; i < keys.length; i++) {
                if (Object.prototype.hasOwnProperty.call(options, keys[i])) deps[keys[i]] = options[keys[i]];
            }
            return api;
        }

        // ── focus recovery (Req 18.9) ────────────────────────────────────
        function isConnected(el) {
            if (!el) return false;
            if (typeof el.isConnected === "boolean") return el.isConnected;
            var d = doc();
            return !!(d && d.documentElement && typeof d.documentElement.contains === "function" && d.documentElement.contains(el));
        }

        function isHiddenByAncestor(el) {
            var gcs = deps.getComputedStyle || (win() && typeof win().getComputedStyle === "function" ? win().getComputedStyle.bind(win()) : null);
            var node = el;
            while (node && node.nodeType === 1) {
                if (node.hidden === true) return true;
                if (gcs) {
                    try {
                        var st = gcs(node);
                        if (st && (st.visibility === "hidden" || st.display === "none")) return true;
                    } catch (e) { /* ignore */ }
                }
                node = node.parentNode;
            }
            return false;
        }

        function isBusyOnly(el) {
            return !!(el && typeof el.getAttribute === "function" && el.getAttribute("aria-busy") === "true");
        }

        function isUsable(el) {
            var d = doc();
            if (!el || (d && el === d.body)) return false;
            if (!isConnected(el)) return false;
            if (typeof el.getClientRects === "function" && el.getClientRects().length === 0) return false;
            if (isHiddenByAncestor(el)) return false;
            if (el.disabled === true && !isBusyOnly(el)) return false;
            return true;
        }

        function recoveryTarget() {
            var d = doc();
            var palette = deps.palette || root.CommandPalette || null;
            if (palette && typeof palette.isOpen === "function" && palette.isOpen()) {
                var input = d && d.getElementById ? d.getElementById("cs-cmd-input") : null;
                if (input) return { el: input };
            }
            var trap = deps.focusTrap || root.FocusTrap || null;
            if (trap && typeof trap.isActive === "function" && trap.isActive() && typeof trap.getActive === "function") {
                var modal = trap.getActive();
                if (modal && typeof modal.querySelectorAll === "function") {
                    var list = modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
                    for (var i = 0; i < list.length; i++) if (isUsable(list[i])) return { el: list[i] };
                }
            }
            return { sidebar: true };
        }

        function runCheck(reason) {
            var d = doc();
            if (!d) return false;
            if (typeof d.hasFocus === "function" && !d.hasFocus()) return false;
            var active = d.activeElement;
            if (active && active !== d.body && isUsable(active)) return false;
            if (lastFocused && lastFocused !== active && isUsable(lastFocused)) return false;
            var target = recoveryTarget();
            if (target.el) {
                if (typeof target.el.focus === "function") target.el.focus();
                return true;
            }
            var sidebar = deps.sidebar || root.CompSaverSidebar || null;
            if (sidebar && typeof sidebar.focusActive === "function") return sidebar.focusActive() === true;
            return false;
        }

        function check(reason) {
            if (checkScheduled) return;
            checkScheduled = true;
            later(function () {
                checkScheduled = false;
                try { runCheck(reason); } catch (e) { /* never escapes */ }
            });
        }

        // ── reduced motion (Req 18.6, 18.7) ──────────────────────────────
        function motionQuery() {
            if (motionMql) return motionMql;
            var mm = matchMediaFn();
            if (!mm) return null;
            try { motionMql = mm("(prefers-reduced-motion: reduce)"); } catch (e) { motionMql = null; }
            if (motionMql) {
                var handler = function () {
                    var value = !!motionMql.matches;
                    for (var i = 0; i < motionListeners.length; i++) {
                        try { motionListeners[i](value); } catch (e) { /* ignore */ }
                    }
                };
                if (typeof motionMql.addEventListener === "function") motionMql.addEventListener("change", handler);
                else if (typeof motionMql.addListener === "function") motionMql.addListener(handler);
            }
            return motionMql;
        }

        function prefersReducedMotion() {
            var q = motionQuery();
            return !!(q && q.matches);
        }

        function onReducedMotionChange(fn) {
            if (typeof fn !== "function") return function () { };
            motionQuery();
            motionListeners.push(fn);
            return function () {
                for (var i = 0; i < motionListeners.length; i++) {
                    if (motionListeners[i] === fn) { motionListeners.splice(i, 1); break; }
                }
            };
        }

        var api = {
            SETS: SETS,
            keyInterestFor: keyInterestFor,
            init: init,
            configure: configure,
            register: register,
            setKeyboardModality: setKeyboardModality,
            setPointerModality: setPointerModality,
            getModality: function () { return modality; },
            getKeySet: function () { return currentSet; },
            check: check,
            runCheck: runCheck,
            isUsable: isUsable,
            prefersReducedMotion: prefersReducedMotion,
            onReducedMotionChange: onReducedMotionChange,
            _onKeyDown: onKeyDown,
            _onKeyUp: onKeyUp,
            _onFocusIn: onFocusIn
        };
        return api;
    }

    var CompSaverFocus = createFocusManager();
    CompSaverFocus.create = createFocusManager;
    root.CompSaverFocus = CompSaverFocus;
    if (typeof module !== "undefined" && module.exports) module.exports = CompSaverFocus;
})(typeof window !== "undefined" ? window : globalThis);
