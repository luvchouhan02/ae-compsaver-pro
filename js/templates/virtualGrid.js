// ============================================================
// templates/virtualGrid.js — CEP-safe windowed card grid
// ------------------------------------------------------------
// Mounts only the viewport window plus overscan rows of a card list
// into the existing .grid-container (display:grid + overflow scroll),
// keeping a stable total scroll height via two full-row spacers so
// columns stay CSS auto-fill responsive:
//
//   [ .vg-spacer (top, grid-column:1/-1, height = rowsAbove*rowH) ]
//   [ mounted cards...                                            ]
//   [ .vg-spacer (bottom, height = rowsBelow*rowH)                ]
//
// Guarantees:
//   - mounted card count bounded by window+overscan, not list length
//   - rAF-batched paints (setTimeout(16) fallback for older CEF); a
//     coalesced paint always resolves against the CURRENT list and
//     offset, so no scroll is ever left unpainted
//   - scroll offsets remembered per list key (section+category) and
//     restored without smooth scrolling
//   - metric reads (columns, row height) happen once per layout
//     generation, never inside card loops
//   - renderTemplateCardMarkup stays THE card markup source; card
//     markup, ids, data attributes and delegation are unchanged
//
// Depends on globals: document, renderTemplateCardMarkup (set via
// options), TemplateCatalog (for record lookup), requestAnimationFrame
// (optional). Load AFTER templateCatalog.js, BEFORE templates.js.
// ============================================================

var VirtualGrid = (function () {
    "use strict";

    var OVERSCAN_ROWS = 2;
    var FALLBACK_ROW_H = 180;     // until a real card is measurable
    var FALLBACK_MIN_CARD_W = 72; // matches --tpl-grid-min default

    var states = {};              // gridId -> state
    var rafImpl = null;
    var markupFor = null;         // injected: (record, section, selected) -> html

    // Older CEF builds treat a non-boolean third addEventListener argument as
    // capture; feature-detect once and fall back to a plain boolean.
    var PASSIVE_OK = (function () {
        try {
            if (typeof document === "undefined" || !document.createElement) return false;
            var probe = document.createElement("div");
            var ok = false;
            var opts = Object.defineProperty({}, "passive", {
                get: function () { ok = true; return true; }
            });
            probe.addEventListener("p", function () { }, opts);
            probe.removeEventListener("p", function () { }, opts);
            return ok;
        } catch (e) {
            return false;
        }
    })();
    function addListener(el, name, fn) {
        el.addEventListener(name, fn, PASSIVE_OK ? { passive: true } : false);
    }

    function schedule(fn) {
        if (typeof rafImpl === "function") return rafImpl(fn);
        return setTimeout(fn, 16);
    }

    function ensureState(gridId, grid) {
        if (!states[gridId]) {
            states[gridId] = {
                gridId: gridId,
                grid: grid,
                ids: [],
                key: "",
                rowH: 0,
                columns: 0,
                rowHMeasured: false,
                metricsSettled: false,
                metricsVerified: false,
                verifyScheduled: false,
                measuredWidth: -1,
                metricsDirty: true,
                windowFirst: -1,
                windowLast: -1,
                paintScheduled: false,
                paintVersion: 0,
                scrollTop: 0,
                scrollMemory: {},   // listKey -> px
                selectedKeys: [],
                onPainted: null
            };
        }
        return states[gridId];
    }

    function invalidateMetrics() {
        for (var id in states) {
            if (Object.prototype.hasOwnProperty.call(states, id)) {
                states[id].metricsDirty = true;
                // A resize re-lays out the grid, so an earlier verification
                // describes a layout that is gone.
                states[id].metricsVerified = false;
            }
        }
    }

    // ── Metrics: one read per generation, never in card loops ───────
    function measure(state) {
        var grid = state.grid;
        var columns = 0;
        var rowH = 0;

        try {
            var cs = window.getComputedStyle ? window.getComputedStyle(grid) : null;
            if (cs && cs.gridTemplateColumns) {
                var tracks = String(cs.gridTemplateColumns).split(" ");
                for (var i = 0; i < tracks.length; i++) {
                    if (tracks[i] !== "0px" && parseFloat(tracks[i]) > 0) columns++;
                }
            }
        } catch (eC) { }

        if (columns < 1) {
            // Fallback for engines where gridTemplateColumns is not
            // serialized: derive columns from the container width.
            var width = grid.clientWidth || 0;
            columns = Math.max(1, Math.floor(width / FALLBACK_MIN_CARD_W));
        }

        var card = grid.querySelector(".card:not(.vg-spacer)");
        if (card && card.offsetHeight) {
            rowH = card.offsetHeight;
            try {
                var cs2 = window.getComputedStyle ? window.getComputedStyle(grid) : null;
                var gap = cs2 ? (parseFloat(cs2.rowGap) || 0) : 0;
                rowH += gap;
            } catch (eG) { }
        }
        // Record whether this is a real measurement or the standing guess. The
        // first measure of a section runs BEFORE any card is mounted, so it is
        // always the guess, and every spacer height is a multiple of rowH — a
        // wrong guess is a block of empty space at the end of the list.
        state.rowHMeasured = !!(rowH && rowH >= 40);
        if (!state.rowHMeasured) rowH = FALLBACK_ROW_H;

        // A container that is display:none — or simply not laid out yet — reports
        // zero width and height, so columns AND the window size are guesses too.
        // Sections that share one grid element (icon/overlay both live in
        // #icon-list-container) hit this on every switch: the list is declared
        // before the container is shown.
        var laidOut = (grid.clientWidth || 0) > 0 && (grid.clientHeight || 0) > 0;
        state.metricsSettled = laidOut && state.rowHMeasured;
        state.measuredWidth = grid.clientWidth || 0;

        state.columns = columns;
        state.rowH = rowH;
        state.metricsDirty = false;
    }

    // Re-measure while any metric is still a guess, and repaint when the guess
    // was wrong. Costs one forced layout per section generation — the same budget
    // measure() already spends.
    //
    // Iterating matters: card height depends on column WIDTH (the cards carry an
    // aspect ratio), so the paint that corrects a guessed column count changes
    // the row pitch too. Settling in one pass left rowH measured against the old
    // layout — and a row pitch that is too large maps a deep scrollTop to too low
    // a row, so the last rows of the list can never enter the window however far
    // the user scrolls. Bounded at three passes so no layout can spin here.
    //
    // `verify` records that the metrics were re-read against a laid-out grid and
    // came back UNCHANGED. That is a stronger claim than metricsSettled, which
    // only says something was measurable: a section switch briefly lays the
    // shared grid out at a different width (panel/sidebar transitions), and
    // measuring in that window produced a real-looking rowH from a layout that no
    // longer exists. Only a stable re-read counts.
    function settleMetrics(state, offset, force, verify) {
        if (!force && state.metricsSettled) return false;
        var changed = false;
        var stable = false;
        for (var pass = 0; pass < 3; pass++) {
            var rowH = state.rowH;
            var columns = state.columns;
            state.metricsDirty = true;
            measure(state);
            if (state.rowH === rowH && state.columns === columns) { stable = true; break; }
            var win = windowFor(state, offset);
            paintWindow(state, win.first, win.last);
            changed = true;
        }
        if (verify && stable && state.metricsSettled) state.metricsVerified = true;
        if (changed && state && typeof state.onPainted === "function" && state.grid) {
            try { state.onPainted(state.grid); } catch (eP) { }
        }
        return changed;
    }

    // A section that renders while its container is hidden — or mid-transition —
    // cannot be measured for real: the window comes out frozen and scrolling
    // never mounts the rest of the list. Re-check over the next few frames so the
    // grid heals itself once the layout is final, rather than waiting for an
    // interaction that would not change the frozen window anyway.
    function scheduleVerify(state, offset) {
        if (state.verifyScheduled) return;
        var attempts = 0;
        function attempt() {
            state.verifyScheduled = false;
            settleMetrics(state, state.grid.scrollTop || offset || 0, true, true);
            if (state.metricsVerified || ++attempts >= 3) return;
            state.verifyScheduled = true;
            schedule(attempt);
        }
        state.verifyScheduled = true;
        schedule(attempt);
    }

    function spacer(el, height) {
        el.style.height = height + "px";
    }

    function ensureSpacers(state) {
        var grid = state.grid;
        if (!state.topSpacer) {
            state.topSpacer = document.createElement("div");
            state.topSpacer.className = "vg-spacer vg-spacer-top";
            state.topSpacer.setAttribute("aria-hidden", "true");
        }
        if (!state.bottomSpacer) {
            state.bottomSpacer = document.createElement("div");
            state.bottomSpacer.className = "vg-spacer vg-spacer-bottom";
            state.bottomSpacer.setAttribute("aria-hidden", "true");
        }
        if (state.topSpacer.parentNode !== grid || state.bottomSpacer.parentNode !== grid) {
            clearChildren(grid);
            grid.appendChild(state.topSpacer);
            grid.appendChild(state.bottomSpacer);
        }
    }

    function clearChildren(el) {
        while (el.firstChild) el.removeChild(el.firstChild);
    }

    // Replace the mounted window. Reads are done; this is pure writes.
    function paintWindow(state, firstIdx, lastIdxExclusive) {
        var grid = state.grid;
        ensureSpacers(state);

        var total = state.ids.length;
        if (firstIdx < 0) firstIdx = 0;
        if (lastIdxExclusive > total) lastIdxExclusive = total;

        var rowsAbove = Math.floor(firstIdx / state.columns);
        var rowsMid = Math.ceil((lastIdxExclusive - firstIdx) / state.columns);
        var rowsTotal = Math.ceil(total / state.columns);
        var rowsBelow = Math.max(0, rowsTotal - rowsAbove - rowsMid);

        spacer(state.topSpacer, rowsAbove * state.rowH);
        spacer(state.bottomSpacer, rowsBelow * state.rowH);

        var html = [];
        var section = state.section;
        for (var i = firstIdx; i < lastIdxExclusive; i++) {
            var record = TemplateCatalog.get(state.ids[i]);
            if (record) html.push(markupFor(record, section, state.selectedKeys));
        }

        // Detached parse, then a single structural splice: cards stay direct
        // grid children so auto-fill columns are untouched.
        var holder = document.createElement("div");
        holder.innerHTML = html.join("");
        var fragment = document.createDocumentFragment();
        while (holder.firstChild) fragment.appendChild(holder.firstChild);

        if (typeof grid.replaceChildren === "function") {
            grid.replaceChildren(state.topSpacer, fragment, state.bottomSpacer);
        } else {
            clearChildren(grid);
            grid.appendChild(state.topSpacer);
            grid.appendChild(fragment);
            grid.appendChild(state.bottomSpacer);
        }

        state.windowFirst = firstIdx;
        state.windowLast = lastIdxExclusive;
    }

    function windowFor(state, scrollTop, viewportH) {
        var total = state.ids.length;
        var rowsTotal = Math.ceil(total / state.columns);
        var firstRow = Math.floor(scrollTop / state.rowH);
        var visibleRows = Math.ceil((viewportH || state.grid.clientHeight || 600) / state.rowH);
        var startRow = firstRow - OVERSCAN_ROWS;
        if (startRow < 0) startRow = 0;
        // A list that SHRANK can leave the offset past its own end, and an engine
        // only re-clamps scrollTop after layout. Without this the window came out
        // inverted (first > last), which paints zero cards under a full-height top
        // spacer — a grid that scrolls but shows nothing.
        if (startRow > rowsTotal - 1) startRow = Math.max(0, rowsTotal - 1);
        var endRow = firstRow + visibleRows + OVERSCAN_ROWS;
        if (endRow > rowsTotal) endRow = rowsTotal;
        if (endRow < startRow + 1) endRow = Math.min(rowsTotal, startRow + 1);
        return {
            first: startRow * state.columns,
            last: Math.min(total, endRow * state.columns)
        };
    }

    function paintForScroll(state) {
        // An empty list belongs to the caller's per-section empty state, which is
        // not built out of spacers: repainting over it would wipe that message
        // and leave a blank grid behind.
        if (!state.ids.length) return;
        var win = windowFor(state, state.grid.scrollTop);
        if (win.first === state.windowFirst && win.last === state.windowLast) return;
        paintWindow(state, win.first, win.last);
        if (state && typeof state.onPainted === "function" && state.grid) {
            try { state.onPainted(state.grid); } catch (eP) { }
        }
    }

    function schedulePaint(state) {
        if (state.paintScheduled) return;
        state.paintScheduled = true;
        schedule(function () {
            state.paintScheduled = false;
            // No version gate here. paintForScroll reads ids, columns, rowH and
            // scrollTop at RUN time, so it cannot paint a superseded list — while
            // dropping the frame lost a real paint whenever a render or a resync
            // bumped the version between a scroll and its frame: the coalescing
            // flag was already set, so the scroll that mattered never got a frame
            // of its own and the grid kept showing the window for an offset the
            // user had left. That is a blank viewport with a live scrollbar.
            paintForScroll(state);
        });
    }

    function onScroll(state) {
        if (state.metricsDirty) measure(state);
        // Metrics that were never verified against the final layout, or that were
        // taken at a different container width, describe a grid that no longer
        // exists — and a wrong row pitch maps a deep scrollTop to the wrong row,
        // so the end of the list can never enter the window. Re-read them now
        // that the user is interacting with the real thing.
        if (!state.metricsVerified || state.measuredWidth !== (state.grid.clientWidth || 0)) {
            settleMetrics(state, state.grid.scrollTop || 0, true, true);
        }
        schedulePaint(state);
    }

    function attachScroll(state) {
        if (state.scrollBound) return;
        state.scrollBound = true;
        addListener(state.grid, "scroll", function () { onScroll(state); });
    }

    // ── Public API ─────────────────────────────────────────────────
    // render(gridId, grid, listKey, ids, options):
    //   options.section       — current section for markup
    //   options.selectedKeys  — bulk-selection keys
    //   options.rememberScroll / restoreScroll — per-listKey offset memory
    //   options.onPainted     — callback after a real paint (hover rebind)
    function render(gridId, grid, listKey, ids, options) {
        options = options || {};
        var state = ensureState(gridId, grid);
        state.grid = grid;
        state.section = options.section;
        state.selectedKeys = options.selectedKeys || [];
        if (typeof options.onPainted === "function") {
            state.onPainted = options.onPainted;
        }

        if (state.key && state.key !== listKey && state.grid.scrollTop !== undefined) {
            state.scrollMemory[state.key] = state.grid.scrollTop;
        }

        // A view change can restyle the cards — sections that SHARE one grid
        // element (icon and overlay both live in #icon-list-container) are the
        // clear case — so metrics verified for the previous view say nothing
        // about this one.
        if (state.key !== listKey) {
            state.metricsVerified = false;
            state.metricsDirty = true;
        }

        var empty = !ids || ids.length === 0;
        if (empty) {
            state.ids = [];
            state.key = listKey;
            state.windowFirst = -1;
            state.windowLast = -1;
            state.paintVersion++;
            state.grid.scrollTop = 0;
            return 0;
        }

        state.ids = ids;
        state.key = listKey;
        state.paintVersion++;

        if (state.metricsDirty) measure(state);
        attachScroll(state);

        var targetScroll = (options.restoreScroll && state.scrollMemory[listKey]) || 0;
        state.grid.scrollTop = 0;                     // reset before sizing
        var win = windowFor(state, targetScroll, options.viewportH);
        paintWindow(state, win.first, win.last);      // synchronous first paint
        settleMetrics(state, targetScroll, false, false);   // real cards exist now
        scheduleVerify(state, targetScroll);          // confirm against final layout
        if (targetScroll) state.grid.scrollTop = targetScroll;

        if (typeof state.onPainted === "function" && state.grid) {
            try { state.onPainted(state.grid); } catch (eP) { }
        }
        return win.last - win.first;
    }

    // sync(gridId, ids, options):
    //   Replace the id list of an ALREADY RENDERED grid and repaint the window
    //   for the offset the user is currently at, without touching scroll memory
    //   or resetting scrollTop.
    //
    // Why this exists separately from render(): a paint replaces the grid's
    // children, so any card a second writer appended straight into the grid
    // (the media import path in js/core/fastMediaEngine.js inserts optimistic
    // cards through KeyedMediaCardHelper) is destroyed by the next scroll, and
    // the spacers are still sized from the list this module knew about BEFORE
    // the import — so the grid went blank below the fold. Re-declaring the ids
    // through render() would fix the list but also send the user back to the top
    // (scrollMemory only holds an offset for a PREVIOUS list key), which is the
    // wrong thing to do while they are scrolling. sync keeps the offset.
    //
    // Returns false when this grid has never been rendered (no state to update)
    // or the new list is empty; the caller then owns the full render / empty
    // state as usual.
    function sync(gridId, ids, options) {
        var state = states[gridId];
        if (!state || !state.grid || !ids || ids.length === 0) return false;
        options = options || {};

        state.ids = ids;
        if (options.section !== undefined) state.section = options.section;
        if (options.selectedKeys) state.selectedKeys = options.selectedKeys;
        if (options.onPainted !== undefined) {
            state.onPainted = (typeof options.onPainted === "function") ? options.onPainted : null;
        }
        state.paintVersion++;                        // supersede any queued paint

        if (state.metricsDirty) measure(state);
        attachScroll(state);

        var offset = state.grid.scrollTop || 0;
        var win = windowFor(state, offset);
        paintWindow(state, win.first, win.last);
        settleMetrics(state, offset, false, false);
        scheduleVerify(state, offset);

        // A shrinking list shortens the spacers, and the engine then clamps
        // scrollTop for us. Repaint once against the offset it settled on so the
        // mounted window still matches what is actually on screen.
        var settledOffset = state.grid.scrollTop || 0;
        if (settledOffset !== offset) {
            var settled = windowFor(state, settledOffset);
            if (settled.first !== state.windowFirst || settled.last !== state.windowLast) {
                paintWindow(state, settled.first, settled.last);
            }
        }

        if (typeof state.onPainted === "function" && state.grid) {
            try { state.onPainted(state.grid); } catch (eP) { }
        }
        return true;
    }

    // The list key the grid is currently painted for, or null when unrendered.
    // Lets a caller tell "same view, list grew" (sync) from "different view"
    // (full render) without reaching into _states.
    function listKeyOf(gridId) {
        var state = states[gridId];
        return state && state.key ? state.key : null;
    }

    function mountedCount(gridId) {
        var state = states[gridId];
        if (!state) return 0;
        return Math.max(0, state.windowLast - state.windowFirst);
    }

    function forget(gridId) {
        delete states[gridId];
    }

    function init(options) {
        options = options || {};
        if (typeof options.requestAnimationFrame === "function") rafImpl = options.requestAnimationFrame;
        else if (typeof requestAnimationFrame === "function") rafImpl = requestAnimationFrame;
        if (typeof options.markupFor === "function") markupFor = options.markupFor;
        if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
            addListener(window, "resize", function () { invalidateMetrics(); });
        }
    }

    return {
        render: render,
        sync: sync,
        listKeyOf: listKeyOf,
        mountedCount: mountedCount,
        forget: forget,
        invalidateMetrics: invalidateMetrics,
        init: init,
        _states: states
    };
})();
