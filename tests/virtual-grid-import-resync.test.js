/**
 * Windowed grid / import resync
 * =============================
 *
 * The reported defect
 * -------------------
 * After importing icons, only the first screenful of templates rendered.
 * Scrolling down showed EMPTY space where the imported cards should have been,
 * while typing in the search box or switching category made every one of them
 * appear again.
 *
 * The mechanism
 * -------------
 * Two writers own the same `.grid-container` children:
 *
 *   1. the media import path (js/core/fastMediaEngine.js), which appends an
 *      optimistic card per accepted file straight into the grid through
 *      KeyedMediaCardHelper.insertBatch, so a card shows up immediately, and
 *   2. VirtualGrid (js/templates/virtualGrid.js), which repaints by REPLACING
 *      the grid's children and sizes its two scroll spacers from its OWN id
 *      list.
 *
 * Nothing told VirtualGrid the list had grown — `gridRefresh` was wired to a
 * no-op — so the first scroll after an import replaced the children (deleting
 * every directly inserted card) and laid the scroll height out for the
 * PRE-import list. Search and category switch looked fine because they rebuild
 * the ids from TemplateCatalog through renderWindowedIds.
 *
 * What this file pins
 * -------------------
 *   A. the mechanism itself: a repaint is authoritative over the grid's
 *      children, so a card a second writer appended cannot survive one, and
 *      with a stale id list the appended records are unreachable by scrolling;
 *   B. the fix: after VirtualGrid.sync re-declares the grown list, a full
 *      scroll sweep mounts EVERY record and the total scroll height always
 *      matches the full list (no blank tail);
 *   C. sync keeps the reader where they were, unlike a re-render;
 *   D. sync declines an unrendered grid / an empty list, so the caller still
 *      owns the full render and the per-section empty state;
 *   E. KeyedMediaCardHelper.patchById adopts the node a repaint substituted for
 *      the one it registered, while a genuinely removed card still reports
 *      `detached-card`;
 *   F. the production wiring: fastMediaEngine's gridRefresh is no longer a
 *      no-op and reaches templates.js's syncSectionGridWindow.
 *
 * How the DOM is provided
 * -----------------------
 * Jest runs `testEnvironment: "node"` and the project adds no packages, so
 * tests/helpers/miniDom.js supplies a real HTML tokenizer + tree builder. This
 * file extends it with the LAYOUT surface VirtualGrid reads — scrollTop that
 * clamps on read exactly as an engine re-clamps after layout, clientHeight,
 * offsetHeight, inline style height, replaceChildren and scroll listeners — so
 * the real module runs unmodified against real parsed markup.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { loadHelpers, REPO_ROOT } = require("./helpers/loadHelpers.js");
const { createMiniDocument, MiniElement } = require("./helpers/miniDom.js");
const { KeyedMediaCardHelper } = require("../js/core/keyedMediaCardHelper.js");

// ─── Real card markup (js/templates/templates.js, no module system) ──────────
const vgConstants = loadHelpers({ file: path.join("js", "core", "constants.js") });
const vgUtils = loadHelpers({
    file: path.join("js", "core", "utils.js"),
    injected: {
        SECTIONS: vgConstants.get("SECTIONS"),
        IMAGE_SECTIONS: vgConstants.get("IMAGE_SECTIONS"),
    },
});
const vgTemplates = loadHelpers({
    file: path.join("js", "templates", "templates.js"),
    injected: {
        SECTIONS: vgConstants.get("SECTIONS"),
        IMAGE_SECTIONS: vgConstants.get("IMAGE_SECTIONS"),
        escapeAttr: vgUtils.get("escapeAttr"),
        escapeHTML: vgUtils.get("escapeHTML"),
        nfs: function () { return { existsSync: function () { return false; } }; },
        allTemplates: [],
        showToast: function () { },
        rootPath: "",
    },
});
const renderTemplateCardMarkup = vgTemplates.get("renderTemplateCardMarkup");
if (typeof renderTemplateCardMarkup !== "function") {
    throw new Error("this suite requires renderTemplateCardMarkup from js/templates/templates.js");
}

// ─── Layout surface for miniDom (this file's module instance only) ───────────
const CARD_H = 52;     // one card's box
const ROW_GAP = 8;     // grid row-gap => rowH = 60
const COLUMNS = 4;
const ROW_H = CARD_H + ROW_GAP;
const VIEWPORT_H = 240;  // 4 visible rows; OVERSCAN_ROWS = 2 on each side

// The transient narrower layout a section switch passes through. Card height
// tracks column width in the real CSS (the cards carry an aspect ratio), so
// fewer columns means a taller card and a larger row pitch.
const NARROW_COLUMNS = 2;
const NARROW_CARD_H = 112;

function isCard(node) {
    if (!node || node.nodeType !== 1) return false;
    const tokens = String(node.className || "").split(/\s+/);
    return tokens.indexOf("card") !== -1 && tokens.indexOf("vg-spacer") === -1;
}

function isSpacer(node) {
    if (!node || node.nodeType !== 1) return false;
    return String(node.className || "").split(/\s+/).indexOf("vg-spacer") !== -1;
}

// A card is as tall as its owning grid's current layout says; everything else
// contributes its inline style height. Inside a container that is not laid out
// (display:none — how the shared icon/overlay grid renders on a section switch)
// every box measures zero, which is what makes the metrics a guess.
function owningLayout(node) {
    let walk = node;
    while (walk) {
        if (typeof walk.__vgLayout === "function") return walk.__vgLayout();
        walk = walk.parentNode;
    }
    return null;
}

Object.defineProperty(MiniElement.prototype, "offsetHeight", {
    configurable: true,
    get: function () {
        const layout = owningLayout(this);
        if (layout && layout.hidden) return 0;
        if (isCard(this)) return layout ? layout.cardHeight : CARD_H;
        return parseFloat(this.style.height) || 0;
    },
});

Object.defineProperty(MiniElement.prototype, "style", {
    configurable: true,
    get: function () {
        if (!this._style) this._style = {};
        return this._style;
    },
});

// miniDom's selector engine has no :not() support, and measure() asks for
// ".card:not(.vg-spacer)". Resolve that one form structurally so the real
// measurement path runs instead of silently falling back to FALLBACK_ROW_H.
function installCardSelector(element) {
    const inherited = element.querySelector;
    element.querySelector = function (selector) {
        if (selector === ".card:not(.vg-spacer)") {
            for (let i = 0; i < this.childNodes.length; i++) {
                if (isCard(this.childNodes[i])) return this.childNodes[i];
            }
            return null;
        }
        return inherited.call(this, selector);
    };
}

// The grid: a scroll container whose scrollHeight follows its children and whose
// scrollTop is CLAMPED ON READ, which is what an engine does after re-layout.
function makeGrid(document) {
    const grid = document.createElement("div");
    grid.className = "grid-container";
    let desiredTop = 0;
    let hidden = false;
    let narrow = false;
    const listeners = [];

    function layout() {
        return {
            hidden: hidden,
            columns: narrow ? NARROW_COLUMNS : COLUMNS,
            cardHeight: narrow ? NARROW_CARD_H : CARD_H,
        };
    }

    function contentHeight() {
        // A container with no layout has no scrollable content at all.
        if (hidden) return 0;
        const box = layout();
        let height = 0;
        let cards = 0;
        for (let i = 0; i < grid.childNodes.length; i++) {
            const child = grid.childNodes[i];
            if (isSpacer(child)) height += parseFloat(child.style.height) || 0;
            else if (isCard(child)) cards++;
        }
        return height + Math.ceil(cards / box.columns) * (box.cardHeight + ROW_GAP);
    }

    Object.defineProperty(grid, "clientHeight", { get: function () { return hidden ? 0 : VIEWPORT_H; } });
    Object.defineProperty(grid, "clientWidth", { get: function () { return hidden ? 0 : layout().columns * 80; } });
    Object.defineProperty(grid, "scrollHeight", { get: contentHeight });
    Object.defineProperty(grid, "scrollTop", {
        get: function () {
            const max = Math.max(0, contentHeight() - VIEWPORT_H);
            return Math.min(desiredTop, max);
        },
        set: function (value) {
            desiredTop = Math.max(0, Number(value) || 0);
            for (let i = 0; i < listeners.length; i++) listeners[i]({ type: "scroll" });
        },
    });
    grid.addEventListener = function (name, fn) { if (name === "scroll") listeners.push(fn); };
    grid.removeEventListener = function () { };
    grid.replaceChildren = function () {
        while (grid.firstChild) grid.removeChild(grid.firstChild);
        for (let i = 0; i < arguments.length; i++) grid.appendChild(arguments[i]);
    };
    installCardSelector(grid);
    grid.__contentHeight = contentHeight;
    grid.__scrollListenerCount = function () { return listeners.length; };
    grid.__vgLayout = layout;
    grid.__setHidden = function (value) { hidden = !!value; };
    grid.__setNarrow = function (value) { narrow = !!value; };
    return grid;
}

// miniDom exposes firstChild/removeChild through childNodes only.
function installNodeShims() {
    if (Object.prototype.hasOwnProperty.call(MiniElement.prototype, "firstChild")) return;
    Object.defineProperty(MiniElement.prototype, "firstChild", {
        configurable: true,
        get: function () { return this.childNodes.length ? this.childNodes[0] : null; },
    });
}
installNodeShims();

// ─── Harness: the real VirtualGrid over the fake layout ─────────────────────
function makeHarness(options) {
    options = options || {};
    const document = createMiniDocument();
    const grid = makeGrid(document);
    document.body.appendChild(grid);

    const frames = [];
    const records = {};
    const windowResizeHandlers = [];

    const catalog = {
        get: function (id) {
            return Object.prototype.hasOwnProperty.call(records, "$" + id) ? records["$" + id] : null;
        },
    };

    const windowStub = {
        getComputedStyle: function (element) {
            // A display:none grid serializes no resolved track list, so columns
            // has to be derived from clientWidth — which is also 0. That is the
            // whole reason a hidden render produces guessed metrics.
            const box = element && typeof element.__vgLayout === "function" ? element.__vgLayout() : null;
            if (box && box.hidden) return { gridTemplateColumns: "", rowGap: "" };
            const count = box ? box.columns : COLUMNS;
            const tracks = [];
            for (let i = 0; i < count; i++) tracks.push("80px");
            return { gridTemplateColumns: tracks.join(" "), rowGap: ROW_GAP + "px" };
        },
        addEventListener: function (name, fn) { if (name === "resize") windowResizeHandlers.push(fn); },
        removeEventListener: function () { },
        requestAnimationFrame: function (fn) { frames.push(fn); return frames.length; },
    };

    const loaded = loadHelpers({
        file: path.join("js", "templates", "virtualGrid.js"),
        lenient: false,
        injected: {
            document: document,
            window: windowStub,
            TemplateCatalog: catalog,
            requestAnimationFrame: windowStub.requestAnimationFrame,
            setTimeout: function (fn) { frames.push(fn); return frames.length; },
            clearTimeout: function () { },
        },
    });
    const VirtualGrid = loaded.get("VirtualGrid");
    if (!VirtualGrid || typeof VirtualGrid.render !== "function") {
        throw new Error("virtualGrid.js did not expose VirtualGrid");
    }
    VirtualGrid.init({
        markupFor: renderTemplateCardMarkup,
        requestAnimationFrame: windowStub.requestAnimationFrame,
    });

    function seed(count, prefix) {
        const ids = [];
        for (let i = 0; i < count; i++) {
            const id = (prefix || "rec") + "-" + i;
            records["$" + id] = {
                id: id,
                name: (prefix || "rec") + " " + i,
                category: "Icons",
                type: "media",
                mediaType: "image",
                section: "icon",
                folderPath: "C:/lib/icons/" + id,
                mediaFile: id + ".png",
                thumbnail: "C:/lib/icons/" + id + "/thumb.png",
            };
            ids.push(id);
        }
        return ids;
    }

    function addRecord(entry) {
        records["$" + entry.id] = entry;
    }

    // Run every queued frame, including frames a frame queues.
    function flushFrames(limit) {
        let guard = limit === undefined ? 20 : limit;
        while (frames.length && guard-- > 0) {
            const queued = frames.splice(0, frames.length);
            for (let i = 0; i < queued.length; i++) queued[i]();
        }
    }

    function mountedIds() {
        const out = [];
        for (let i = 0; i < grid.childNodes.length; i++) {
            const child = grid.childNodes[i];
            if (isCard(child)) out.push(String(child.id).replace(/^tpl-/, ""));
        }
        return out;
    }

    return {
        document: document,
        grid: grid,
        gridId: "icon-list-container",
        VirtualGrid: VirtualGrid,
        catalog: catalog,
        records: records,
        seed: seed,
        addRecord: addRecord,
        flushFrames: flushFrames,
        mountedIds: mountedIds,
        hide: function () { grid.__setHidden(true); },
        show: function () { grid.__setHidden(false); },
        narrow: function () { grid.__setNarrow(true); },
        wide: function () { grid.__setNarrow(false); },
        resize: function () { for (let i = 0; i < windowResizeHandlers.length; i++) windowResizeHandlers[i](); },
        pendingFrames: function () { return frames.length; },
    };
}

// Append cards the way KeyedMediaCardHelper.insertBatch does: parsed markup
// appended straight into the grid, bypassing VirtualGrid entirely.
function appendImportedCards(harness, ids) {
    const holder = harness.document.createElement("div");
    let markup = "";
    for (let i = 0; i < ids.length; i++) {
        markup += renderTemplateCardMarkup(harness.catalog.get(ids[i]), "icon", []);
    }
    holder.innerHTML = markup;
    const appended = [];
    while (holder.firstChild) {
        const node = holder.firstChild;
        holder.removeChild(node);
        harness.grid.appendChild(node);
        appended.push(node);
    }
    return appended;
}

// Scroll the whole list one row at a time and record every id that was mounted
// at any point, plus the scroll height seen at each stop.
function scrollSweep(harness) {
    const seen = {};
    const heights = [];
    const max = Math.max(0, harness.grid.__contentHeight() - VIEWPORT_H);
    for (let top = 0; top <= max + ROW_H; top += ROW_H) {
        harness.grid.scrollTop = top;
        harness.flushFrames();
        const ids = harness.mountedIds();
        for (let i = 0; i < ids.length; i++) seen[ids[i]] = true;
        heights.push(harness.grid.__contentHeight());
    }
    return { seen: Object.keys(seen).sort(), heights: heights };
}

function sortedCopy(list) {
    return list.slice().sort();
}

// ─── A. The mechanism, pinned ───────────────────────────────────────────────
describe("a repaint is authoritative over the grid's children", () => {
    test("a card appended by a second writer does not survive the next scroll repaint, and with a stale id list its record is unreachable by scrolling", () => {
        const harness = makeHarness();
        const existing = harness.seed(100, "old");
        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|All|", existing, { section: "icon" });

        // The window is bounded: 4 visible + 2 overscan rows below, 4 columns.
        expect(harness.mountedIds().length).toBe(24);
        expect(harness.grid.__contentHeight()).toBe(Math.ceil(100 / COLUMNS) * ROW_H);

        // An import lands three records and appends their cards directly.
        const imported = harness.seed(3, "new");
        const appended = appendImportedCards(harness, imported);
        for (let i = 0; i < appended.length; i++) {
            expect(harness.document.getElementById("tpl-" + imported[i])).toBe(appended[i]);
        }

        // One scroll later every appended node is gone …
        harness.grid.scrollTop = ROW_H * 6;
        harness.flushFrames();
        for (let i = 0; i < imported.length; i++) {
            expect(harness.document.getElementById("tpl-" + imported[i])).toBe(null);
        }

        // … and because the id list still says 100, scrolling the entire grid
        // never reaches them. This is exactly the reported symptom.
        const sweep = scrollSweep(harness);
        expect(sweep.seen).toEqual(sortedCopy(existing));
        for (let i = 0; i < imported.length; i++) {
            expect(sweep.seen.indexOf(imported[i])).toBe(-1);
        }
    });
});

// ─── B. The fix ────────────────────────────────────────────────────────────
describe("VirtualGrid.sync reconciles the window with a grown list", () => {
    test("after a resync a full scroll sweep mounts every record, and the scroll height matches the full list at every stop", () => {
        const harness = makeHarness();
        const existing = harness.seed(100, "old");
        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|All|", existing, { section: "icon" });

        const imported = harness.seed(7, "new");
        appendImportedCards(harness, imported);

        // The import commit publishes the new records at the head of the model,
        // which is the order TemplateCatalog.idsFor then reports.
        const full = imported.concat(existing);
        expect(harness.VirtualGrid.sync(harness.gridId, full, { section: "icon" })).toBe(true);

        const expectedHeight = Math.ceil(full.length / COLUMNS) * ROW_H;
        expect(harness.grid.__contentHeight()).toBe(expectedHeight);

        const sweep = scrollSweep(harness);
        expect(sweep.seen).toEqual(sortedCopy(full));
        for (let i = 0; i < sweep.heights.length; i++) {
            expect(sweep.heights[i]).toBe(expectedHeight);
        }

        // The mounted count stays bounded by window+overscan throughout: the
        // reconciliation must not degrade into rendering the whole list.
        harness.grid.scrollTop = 0;
        harness.flushFrames();
        expect(harness.mountedIds().length).toBeLessThanOrEqual((4 + 2 * 2) * COLUMNS);
    });

    test("the tail of the list renders instead of blank space", () => {
        const harness = makeHarness();
        const ids = harness.seed(132, "icon");
        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|All|", ids, { section: "icon" });

        const extra = harness.seed(5, "fresh");
        const full = extra.concat(ids);
        harness.VirtualGrid.sync(harness.gridId, full, { section: "icon" });

        harness.grid.scrollTop = 10 * 1000;   // hard to the bottom
        harness.flushFrames();

        const mounted = harness.mountedIds();
        expect(mounted.length).toBeGreaterThan(0);
        // The last record in the list is on screen, and the bottom spacer has
        // collapsed — the two things that were false when the grid went blank.
        expect(mounted.indexOf(full[full.length - 1])).not.toBe(-1);
        const spacers = [];
        for (let i = 0; i < harness.grid.childNodes.length; i++) {
            if (isSpacer(harness.grid.childNodes[i])) spacers.push(harness.grid.childNodes[i]);
        }
        expect(spacers.length).toBe(2);
        expect(parseFloat(spacers[1].style.height)).toBe(0);
    });
});

// ─── C. sync keeps the reader in place ─────────────────────────────────────
describe("scroll offset handling", () => {
    test("sync preserves the current offset and paints the window for it", () => {
        const harness = makeHarness();
        const existing = harness.seed(100, "old");
        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|All|", existing, { section: "icon" });

        const offset = ROW_H * 10;
        harness.grid.scrollTop = offset;
        harness.flushFrames();
        expect(harness.grid.scrollTop).toBe(offset);

        const imported = harness.seed(4, "new");
        harness.VirtualGrid.sync(harness.gridId, imported.concat(existing), { section: "icon" });

        expect(harness.grid.scrollTop).toBe(offset);
        // Rows 8..16 of the new list are the window for that offset (first row
        // 10, minus 2 overscan rows, through 10 + 4 visible + 2 overscan).
        const mounted = harness.mountedIds();
        const full = imported.concat(existing);
        expect(mounted[0]).toBe(full[8 * COLUMNS]);
        expect(mounted.length).toBe(Math.min(full.length, 16 * COLUMNS) - 8 * COLUMNS);
    });

    test("a shrinking list repaints for the offset the grid settles on", () => {
        const harness = makeHarness();
        const existing = harness.seed(100, "old");
        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|All|", existing, { section: "icon" });

        harness.grid.scrollTop = harness.grid.__contentHeight();   // pinned to the bottom
        harness.flushFrames();
        const deepOffset = harness.grid.scrollTop;
        expect(deepOffset).toBeGreaterThan(0);

        // Half the records go away (a delete, or a category filter narrowing).
        const fewer = existing.slice(0, 20);
        harness.VirtualGrid.sync(harness.gridId, fewer, { section: "icon" });

        const settled = harness.grid.scrollTop;
        expect(settled).toBeLessThan(deepOffset);
        expect(settled).toBe(Math.max(0, harness.grid.__contentHeight() - VIEWPORT_H));

        // Whatever offset it settled on, cards are mounted there — not blank.
        const mounted = harness.mountedIds();
        expect(mounted.length).toBeGreaterThan(0);
        expect(mounted.indexOf(fewer[fewer.length - 1])).not.toBe(-1);
    });

    test("a re-render restores remembered scroll per list key, and sync does not disturb that memory", () => {
        const harness = makeHarness();
        const icons = harness.seed(100, "old");
        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|All|", icons, { section: "icon" });
        harness.grid.scrollTop = ROW_H * 9;
        harness.flushFrames();

        harness.VirtualGrid.sync(harness.gridId, icons, { section: "icon" });
        expect(harness.grid.scrollTop).toBe(ROW_H * 9);

        // Switch list key and come back: the offset from before the switch is
        // what gets restored, which sync must not have overwritten.
        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|Favorites|", icons.slice(0, 40), { section: "icon" });
        expect(harness.grid.scrollTop).toBe(0);
        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|All|", icons, { section: "icon", restoreScroll: true });
        expect(harness.grid.scrollTop).toBe(ROW_H * 9);
    });
});

// ─── C2. rendering into a container that is not laid out yet ────────────────
// The icon and overlay sections SHARE #icon-list-container, so a section switch
// declares the new list while the container is still display:none. Nothing about
// it is measurable then: no resolved grid tracks, zero width, zero height, and
// every card box measures zero. The window that comes out of those guesses never
// changes shape, so the user scrolls a grid frozen at its first batch — the same
// "templates blank below the fold" symptom, reached a different way.
describe("a list declared while its container is hidden", () => {
    test("the guessed metrics are marked unsettled instead of being trusted", () => {
        const harness = makeHarness();
        const ids = harness.seed(147, "ov");
        harness.hide();

        harness.VirtualGrid.render(harness.gridId, harness.grid, "overlay|All|", ids, { section: "overlay" });

        const state = harness.VirtualGrid._states[harness.gridId];
        expect(state.metricsSettled).toBe(false);
        expect(state.rowHMeasured).toBe(false);
        expect(state.columns).toBe(1);          // clientWidth 0 => one column
    });

    test("revealing the container settles the metrics on a later frame with no interaction", () => {
        const harness = makeHarness();
        const ids = harness.seed(147, "ov");
        harness.hide();
        harness.VirtualGrid.render(harness.gridId, harness.grid, "overlay|All|", ids, { section: "overlay" });

        const state = harness.VirtualGrid._states[harness.gridId];
        const guessedRowH = state.rowH;
        const guessedColumns = state.columns;

        harness.show();                          // the section switch finishes
        harness.flushFrames();

        expect(state.metricsSettled).toBe(true);
        expect(state.rowH).toBe(ROW_H);
        expect(state.columns).toBe(COLUMNS);
        expect(state.rowH).not.toBe(guessedRowH);
        expect(state.columns).not.toBe(guessedColumns);
    });

    test("a scroll re-measures rather than paging a frozen window", () => {
        const harness = makeHarness();
        const ids = harness.seed(147, "ov");
        harness.hide();
        harness.VirtualGrid.render(harness.gridId, harness.grid, "overlay|All|", ids, { section: "overlay" });
        const state = harness.VirtualGrid._states[harness.gridId];
        const frozenWindow = [state.windowFirst, state.windowLast];

        // Reveal WITHOUT flushing the deferred settle: the only thing that runs
        // next is the user's scroll, which is exactly the reported case.
        harness.show();
        harness.grid.scrollTop = ROW_H * 12;
        harness.flushFrames();

        expect(state.metricsSettled).toBe(true);
        expect([state.windowFirst, state.windowLast]).not.toEqual(frozenWindow);
        expect(harness.mountedIds().length).toBeGreaterThan(0);
    });

    test("every record is reachable by scrolling after a hidden render", () => {
        const harness = makeHarness();
        const ids = harness.seed(147, "ov");
        harness.hide();
        harness.VirtualGrid.render(harness.gridId, harness.grid, "overlay|All|", ids, { section: "overlay" });
        harness.show();
        harness.flushFrames();

        const swept = scrollSweep(harness);
        expect(swept.seen).toEqual(sortedCopy(ids));

        // And the content height is the full list, not a first-batch stub.
        const expectedHeight = Math.ceil(ids.length / COLUMNS) * ROW_H;
        for (let i = 0; i < swept.heights.length; i++) {
            expect(swept.heights[i]).toBe(expectedHeight);
        }
    });

    test("the window stays bounded once the metrics settle", () => {
        const harness = makeHarness();
        const ids = harness.seed(147, "ov");
        harness.hide();
        harness.VirtualGrid.render(harness.gridId, harness.grid, "overlay|All|", ids, { section: "overlay" });
        harness.show();
        harness.flushFrames();

        // 4 visible rows + 2 overscan each side = at most 8 rows mounted.
        expect(harness.mountedIds().length).toBeLessThanOrEqual(8 * COLUMNS);
        expect(harness.VirtualGrid.mountedCount(harness.gridId)).toBeLessThanOrEqual(8 * COLUMNS);
    });

    test("the deferred verification gives up instead of re-queuing frames forever", () => {
        const harness = makeHarness();
        const ids = harness.seed(147, "ov");
        harness.hide();
        harness.VirtualGrid.render(harness.gridId, harness.grid, "overlay|All|", ids, { section: "overlay" });

        // The container is never revealed (the user never opens that section).
        harness.flushFrames();
        const state = harness.VirtualGrid._states[harness.gridId];
        expect(state.metricsSettled).toBe(false);
        expect(state.metricsVerified).toBe(false);
        expect(state.verifyScheduled).toBe(false);
        expect(harness.pendingFrames()).toBe(0);
    });
});

// ─── C3. metrics taken against a layout that then changed ───────────────────
// A section switch lays the shared grid out at an intermediate width before the
// panel settles, so a measurement taken there is real-looking but describes a
// layout that is already gone. Card height tracks column width, so the row pitch
// is wrong too — and too large a pitch maps a deep scrollTop to too low a row,
// which is why the last rows of the Icon list stayed unreachable no matter how
// far the user scrolled, even though nothing was blank.
describe("metrics measured against a layout that changed", () => {
    test("a scroll re-reads metrics that were taken at a different container width", () => {
        const harness = makeHarness();
        const ids = harness.seed(132, "ic");

        harness.narrow();     // the transient mid-switch layout
        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|All|", ids, { section: "icon" });
        const state = harness.VirtualGrid._states[harness.gridId];
        expect(state.columns).toBe(NARROW_COLUMNS);
        expect(state.rowH).toBe(NARROW_CARD_H + ROW_GAP);

        harness.wide();       // the layout the user actually sees
        harness.grid.scrollTop = harness.grid.__contentHeight();
        harness.flushFrames();

        expect(state.columns).toBe(COLUMNS);
        expect(state.rowH).toBe(ROW_H);
        expect(state.metricsVerified).toBe(true);
    });

    test("the tail of the list is reachable after a width change", () => {
        const harness = makeHarness();
        const ids = harness.seed(132, "ic");

        harness.narrow();
        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|All|", ids, { section: "icon" });
        harness.wide();

        const swept = scrollSweep(harness);
        expect(swept.seen).toEqual(sortedCopy(ids));
    });

    test("a view change on a shared grid re-reads metrics instead of carrying them over", () => {
        const harness = makeHarness();
        const icons = harness.seed(132, "ic");
        const overlays = harness.seed(147, "ov");

        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|All|", icons, { section: "icon" });
        harness.flushFrames();
        const state = harness.VirtualGrid._states[harness.gridId];
        expect(state.metricsVerified).toBe(true);
        expect(state.rowH).toBe(ROW_H);
        expect(state.columns).toBe(COLUMNS);

        // Same grid element, different section, and this view lays its cards out
        // differently: whatever was verified for the icon view says nothing about
        // the overlay one, so the numbers must be re-read rather than reused.
        harness.narrow();
        harness.VirtualGrid.render(harness.gridId, harness.grid, "overlay|All|", overlays, { section: "overlay" });
        harness.flushFrames();

        expect(state.columns).toBe(NARROW_COLUMNS);
        expect(state.rowH).toBe(NARROW_CARD_H + ROW_GAP);
        expect(state.metricsVerified).toBe(true);

        // And every overlay record is reachable at the new pitch.
        const seen = {};
        const pitch = NARROW_CARD_H + ROW_GAP;
        const max = Math.max(0, harness.grid.__contentHeight() - VIEWPORT_H);
        for (let top = 0; top <= max + pitch; top += pitch) {
            harness.grid.scrollTop = top;
            harness.flushFrames();
            const mounted = harness.mountedIds();
            for (let i = 0; i < mounted.length; i++) seen[mounted[i]] = true;
        }
        expect(Object.keys(seen).sort()).toEqual(sortedCopy(overlays));
    });

    test("a window resize retires the verification so the next scroll re-measures", () => {
        const harness = makeHarness();
        const ids = harness.seed(132, "ic");
        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|All|", ids, { section: "icon" });
        harness.flushFrames();
        const state = harness.VirtualGrid._states[harness.gridId];
        expect(state.metricsVerified).toBe(true);

        harness.resize();
        expect(state.metricsVerified).toBe(false);
        expect(state.metricsDirty).toBe(true);
    });
});

// ─── D. sync declines what it must not own ─────────────────────────────────
describe("sync preconditions", () => {
    test("an unrendered grid and an empty list are both declined so the caller keeps the full render and the empty state", () => {
        const harness = makeHarness();
        const ids = harness.seed(10, "old");

        expect(harness.VirtualGrid.sync(harness.gridId, ids, { section: "icon" })).toBe(false);
        expect(harness.mountedIds().length).toBe(0);

        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|All|", ids, { section: "icon" });
        expect(harness.mountedIds().length).toBe(10);

        expect(harness.VirtualGrid.sync(harness.gridId, [], { section: "icon" })).toBe(false);
        expect(harness.VirtualGrid.sync(harness.gridId, null, { section: "icon" })).toBe(false);
        // Declined means untouched, not cleared.
        expect(harness.mountedIds().length).toBe(10);
    });

    test("listKeyOf reports the key the grid is painted for, so a caller can tell a resync from a view change", () => {
        const harness = makeHarness();
        const ids = harness.seed(10, "old");

        expect(harness.VirtualGrid.listKeyOf(harness.gridId)).toBe(null);
        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|All|", ids, { section: "icon" });
        expect(harness.VirtualGrid.listKeyOf(harness.gridId)).toBe("icon|All|");
        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|Notification|", ids, { section: "icon" });
        expect(harness.VirtualGrid.listKeyOf(harness.gridId)).toBe("icon|Notification|");
        harness.VirtualGrid.forget(harness.gridId);
        expect(harness.VirtualGrid.listKeyOf(harness.gridId)).toBe(null);
    });

    test("sync binds the scroll listener exactly once, however many times it runs", () => {
        const harness = makeHarness();
        const ids = harness.seed(40, "old");
        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|All|", ids, { section: "icon" });
        const bound = harness.grid.__scrollListenerCount();
        for (let i = 0; i < 5; i++) harness.VirtualGrid.sync(harness.gridId, ids, { section: "icon" });
        expect(harness.grid.__scrollListenerCount()).toBe(bound);
    });
});

// ─── E. The keyed helper across a repaint ──────────────────────────────────
describe("KeyedMediaCardHelper across a repaint", () => {
    function mediaEntry(id) {
        return {
            id: id,
            name: "imported " + id,
            category: "Icons",
            type: "media",
            mediaType: "image",
            section: "icon",
            folderPath: "C:/lib/icons/" + id,
            mediaFile: id + ".png",
            _isPending: true,
        };
    }

    test("a patch adopts the node a repaint substituted for the registered one", () => {
        const harness = makeHarness();
        const existing = harness.seed(40, "old");
        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|All|", existing, { section: "icon" });

        const failures = [];
        const cards = new KeyedMediaCardHelper({
            document: harness.document,
            renderCardMarkup: renderTemplateCardMarkup,
            onFailedUpdate: function (reason) { failures.push(reason); },
        });

        const entry = mediaEntry("new-0");
        harness.addRecord(entry);
        const inserted = cards.insertBatch([entry], harness.grid);
        expect(inserted.ok).toBe(true);
        const originalNode = inserted.cards[0];

        // The resync repaints, so the registered node is replaced by a freshly
        // parsed one carrying the same DOM id.
        harness.VirtualGrid.sync(harness.gridId, [entry.id].concat(existing), { section: "icon" });
        const liveNode = harness.document.getElementById("tpl-" + entry.id);
        expect(liveNode).not.toBe(null);
        expect(liveNode).not.toBe(originalNode);

        const patched = cards.patchById(entry.id, {
            thumbnail: "C:/lib/icons/new-0/thumb.png",
            thumbStatus: "ready",
            terminalState: "ready",
            _isPending: false,
        });

        expect(patched.ok).toBe(true);
        expect(patched.card).toBe(liveNode);
        expect(failures).toEqual([]);
        expect(liveNode.getAttribute("data-thumb")).toBe("file:///C:/lib/icons/new-0/thumb.png");
        expect(liveNode.querySelector(".thumb-img").getAttribute("src")).toBe("file:///C:/lib/icons/new-0/thumb.png");
        expect(String(liveNode.className).indexOf("media-pending")).toBe(-1);
        // The node that left the tree is untouched by the patch.
        expect(originalNode.getAttribute("data-thumb")).toBe("");
    });

    test("a card that is genuinely gone from the document still reports detached-card", () => {
        const harness = makeHarness();
        const failures = [];
        const cards = new KeyedMediaCardHelper({
            document: harness.document,
            renderCardMarkup: renderTemplateCardMarkup,
            onFailedUpdate: function (reason) { failures.push(reason); },
        });

        const entry = mediaEntry("orphan-0");
        const inserted = cards.insertBatch([entry], harness.grid);
        expect(inserted.ok).toBe(true);
        harness.grid.removeChild(inserted.cards[0]);

        const patched = cards.patchById(entry.id, { thumbStatus: "ready" });
        expect(patched.ok).toBe(false);
        expect(patched.reason).toBe("detached-card");
        expect(failures).toEqual(["detached-card"]);
    });

    test("a record that is scrolled out of the window is not adopted from a stale node", () => {
        const harness = makeHarness();
        const existing = harness.seed(200, "old");
        const entry = mediaEntry("new-0");
        harness.addRecord(entry);

        harness.VirtualGrid.render(harness.gridId, harness.grid, "icon|All|", existing, { section: "icon" });
        const cards = new KeyedMediaCardHelper({
            document: harness.document,
            renderCardMarkup: renderTemplateCardMarkup,
        });
        expect(cards.insertBatch([entry], harness.grid).ok).toBe(true);

        // Resync, then scroll far past the head where the new record now lives.
        harness.VirtualGrid.sync(harness.gridId, [entry.id].concat(existing), { section: "icon" });
        harness.grid.scrollTop = ROW_H * 30;
        harness.flushFrames();
        expect(harness.document.getElementById("tpl-" + entry.id)).toBe(null);

        // Nothing to patch is reported as a failure, never as a false success
        // against a node that is no longer in the tree.
        const patched = cards.patchById(entry.id, { thumbStatus: "ready" });
        expect(patched.ok).toBe(false);
        expect(patched.reason).toBe("detached-card");
    });
});

// ─── F. Production wiring ──────────────────────────────────────────────────
describe("production wiring", () => {
    const engineSource = fs.readFileSync(path.join(REPO_ROOT, "js", "core", "fastMediaEngine.js"), "utf8");
    const templatesSource = fs.readFileSync(path.join(REPO_ROOT, "js", "templates", "templates.js"), "utf8");

    test("the media coordinator's gridRefresh is a real refresh, not a no-op", () => {
        expect(engineSource).toContain("gridRefresh: productionGridRefresh");
        expect(engineSource).not.toContain("gridRefresh: function () { /* keyed insertion/patching is the media-only grid update */ }");

        const body = engineSource.split("function productionGridRefresh()")[1];
        expect(typeof body).toBe("string");
        expect(body.indexOf("syncSectionGridWindow")).toBeGreaterThan(-1);
    });

    test("syncSectionGridWindow exists and reconciles through the catalog", () => {
        expect(templatesSource).toContain("function syncSectionGridWindow()");
        const body = templatesSource.split("function syncSectionGridWindow()")[1].split("\n}")[0];
        expect(body).toContain("ensureCatalogFresh()");
        expect(body).toContain("TemplateCatalog.idsFor(currentSection, currentCategory, sv)");
        expect(body).toContain("VirtualGrid.sync");
        // Falls back to the full windowed render when the painted view differs.
        expect(body).toContain("renderWindowedIds");
    });

    test("the same list key formula is used by the filter path and the resync path", () => {
        const filterKey = templatesSource.match(/listKey:\s*currentSection \+ "\|" \+ currentCategory \+ "\|" \+ sv/g) || [];
        const syncKey = templatesSource.match(/var listKey = currentSection \+ "\|" \+ currentCategory \+ "\|" \+ sv;/g) || [];
        expect(filterKey.length).toBeGreaterThan(0);
        expect(syncKey.length).toBe(1);
    });
});
