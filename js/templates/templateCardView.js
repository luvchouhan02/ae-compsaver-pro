// ============================================================
// templates/templateCardView.js — dedicated card view renderer
// ------------------------------------------------------------
// Pure DOM card generation, template card markup, bounded initial
// rendering, batch appending, and empty state rendering.
// Extracted from templates.js for clean modularity.
// ============================================================

(function (root) {
    "use strict";

    var TEMPLATE_FIRST_BATCH = 60;
    var TEMPLATE_APPEND_BATCH = 60;

    // Attribute-escape a complete card attribute value. Escaping ampersands first is
    // required so an ID containing entity-like text parses back to the exact value.
    function escapeTemplateCardAttribute(value) {
        return ("" + (value === undefined || value === null ? "" : value))
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    // Side-effect-free single-card markup shared by the generic renderer and the
    // media-only keyed adapter. Keep the existing classes/data attributes intact.
    function renderTemplateCardMarkup(t, section, selectedKeys) {
        t = t || {};
        selectedKeys = selectedKeys || [];

        var sectionsObj = (typeof SECTIONS !== "undefined" ? SECTIONS : (root.SECTIONS || {}));
        var escAttr = (typeof escapeAttr === "function") ? escapeAttr : (root.escapeAttr || function (s) { return String(s); });
        var escHTML = (typeof escapeHTML === "function") ? escapeHTML : (root.escapeHTML || function (s) { return String(s); });

        var COL_FAV_OFF = "rgba(255,255,255,0.55)";
        var COL_FAV_ON = "#fbbf24";
        var thumbSrc = t.thumbnail ? ("" + t.thumbnail).replace(/\\/g, "/") : "";
        if (thumbSrc && !/^file:\/\/\//i.test(thumbSrc)) {
            var thumbFwd = thumbSrc;
            if (thumbFwd.charAt(0) === "/") thumbFwd = thumbFwd.substring(1);
            thumbSrc = "file:///" + encodeURI(thumbFwd);
        }

        var isFav = !!t.favorite;
        var absMediaPath = ("" + (t.proxyFile || t.mediaFile || "")).replace(/\\/g, "/");
        if (absMediaPath && absMediaPath.indexOf(":/") === -1 && absMediaPath.indexOf(":\\") === -1 && t.folderPath) {
            absMediaPath = ("" + t.folderPath).replace(/\\/g, "/") + "/" + absMediaPath;
        }

        var previewUrlAttr = "";
        if (t.previewPath) {
            var previewFwd = ("" + t.previewPath).replace(/\\/g, "/");
            if (previewFwd.charAt(0) === "/") previewFwd = previewFwd.substring(1);
            var previewUrl = "file:///" + encodeURI(previewFwd) + "?v=" + (t.previewMtime || Date.now());
            previewUrlAttr = ' data-preview="' + escAttr(previewUrl) + '"';
        }

        var thumbHTML;
        if (thumbSrc) {
            thumbHTML = '<img class="thumb-img" src="' + escAttr(thumbSrc) + '" alt="">';
        } else if (t.type === "media") {
            // Media cards always retain one stable patch target, including while
            // their optimistic thumbnail is pending.
            thumbHTML = '<img class="thumb-img" alt="">';
        } else if (section === sectionsObj.EFFECT) {
            thumbHTML =
                '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"' +
                ' stroke="rgba(79,140,255,0.4)" stroke-width="1.5" stroke-linejoin="round">' +
                '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>';
        } else {
            thumbHTML =
                '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"' +
                ' stroke="rgba(79,140,255,0.15)" stroke-width="1.5">' +
                '<rect x="3" y="3" width="18" height="18" rx="3"/></svg>';
        }

        var hoverButtonsHTML =
            '<button type="button" class="btn-more card-btn-more" title="More">' +
            '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
            ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
            '<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>' +
            '</svg></button>';
        var favHTML =
            '<button class="btn-favorite' + (isFav ? " active" : "") + '" data-tooltip="">' +
            '<svg width="11" height="11" viewBox="0 0 24 24"' +
            ' fill="' + (isFav ? COL_FAV_ON : "none") + '"' +
            ' stroke="' + (isFav ? COL_FAV_ON : COL_FAV_OFF) + '" stroke-width="2">' +
            '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>' +
            '</svg></button>';

        var cardKey = t.name + "||" + t.category;
        var isSel = selectedKeys.indexOf(cardKey) !== -1 ? " selected-for-delete" : "";
        var isPending = t._isPending ? " media-pending" : "";
        var stableDomId = "tpl-" + (t.id === undefined || t.id === null ? "" : "" + t.id);

        return '<div class="card' + (isFav ? " is-fav" : "") + isSel + isPending + '"' +
            ' style="content-visibility: auto; contain-intrinsic-size: 100% 160px;"' +
            ' id="' + escapeTemplateCardAttribute(stableDomId) + '"' +
            ' title="' + escAttr(t.name) + '"' +
            ' data-file="' + escAttr(t.name) + '"' +
            ' data-cat="' + escAttr(t.category) + '"' +
            ' data-folder="' + escAttr((t.folderPath || "").replace(/\\/g, "/")) + '"' +
            ' data-thumb="' + escAttr(thumbSrc) + '"' +
            (t.type === "media" ? ' data-type="media" data-mediatype="' + escAttr(t.mediaType) + '" data-mediapath="' + escAttr(absMediaPath) + '"' : "") +
            previewUrlAttr + '>' +
            '<div class="card-check">' +
            '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
            '</div>' + favHTML + hoverButtonsHTML +
            '<div class="thumb-box">' + thumbHTML + '</div>' +
            '<div class="card-name">' + escHTML(t.name) + '</div>' +
            '</div>';
    }

    // Single source of truth for the active Card_Grid id.
    function resolveSectionGridId() {
        var sec = (typeof currentSection !== "undefined" ? currentSection : root.currentSection);
        var sectionsObj = (typeof SECTIONS !== "undefined" ? SECTIONS : (root.SECTIONS || {}));
        var isTxt = (typeof isTextSection === "function") ? isTextSection : (root.isTextSection || function () { return false; });
        var isImg = (typeof isImageSection === "function") ? isImageSection : (root.isImageSection || function () { return false; });

        var gridId = "comp-list-container";
        if (sec === sectionsObj.LAYER) gridId = "transition-list-container";
        else if (isTxt(sec)) gridId = "text-list-container";
        else if (sec === sectionsObj.FOOTAGE) gridId = "footage-list-container";
        else if (sec === sectionsObj.EFFECT) gridId = "effect-list-container";
        else if (isImg(sec)) gridId = "icon-list-container";
        return gridId;
    }

    function sectionUsesHoverPreviews() {
        return true;
    }

    function attachSectionHoverPreviews(grid) {
        if (!grid) return;
        if (!sectionUsesHoverPreviews()) return;
        var ta = root.TextAnim || (typeof TextAnim !== "undefined" ? TextAnim : null);
        if (!ta || typeof ta.attachHoverPreviews !== "function") return;
        try {
            ta.attachHoverPreviews(grid);
        } catch (eH) {
            try { console.error("[CompSaver] attachHoverPreviews failed:", eH); } catch (e) { }
        }
    }

    function renderCardsFirstBatch(records) {
        if (!records || typeof records.length !== "number") return 0;
        if (records.length === 0) {
            renderCards(records);
            return 0;
        }

        var grid = document.getElementById(resolveSectionGridId());
        if (!grid) return 0;

        var count = records.length < TEMPLATE_FIRST_BATCH ? records.length : TEMPLATE_FIRST_BATCH;
        var html = [];
        var sec = (typeof currentSection !== "undefined" ? currentSection : root.currentSection);
        var bulkSelected = (typeof tmpBulkSelected !== "undefined" ? tmpBulkSelected : (root.tmpBulkSelected || []));

        for (var i = 0; i < count; i++) {
            html.push(renderTemplateCardMarkup(records[i], sec, bulkSelected));
        }

        grid.innerHTML = html.join("");
        attachSectionHoverPreviews(grid);
        return count;
    }

    function appendCardBatch(records, from, count) {
        if (!records || typeof records.length !== "number") return 0;

        var start = (typeof from === "number" && from > 0) ? from : 0;
        if (start >= records.length) return 0;

        var want = (typeof count === "number" && count > 0) ? count : TEMPLATE_APPEND_BATCH;
        var end = start + want;
        if (end > records.length) end = records.length;
        if (end <= start) return 0;

        var grid = document.getElementById(resolveSectionGridId());
        if (!grid) return 0;
        if (typeof grid.insertAdjacentHTML !== "function") return 0;

        var html = [];
        var sec = (typeof currentSection !== "undefined" ? currentSection : root.currentSection);
        var bulkSelected = (typeof tmpBulkSelected !== "undefined" ? tmpBulkSelected : (root.tmpBulkSelected || []));

        for (var i = start; i < end; i++) {
            html.push(renderTemplateCardMarkup(records[i], sec, bulkSelected));
        }

        grid.insertAdjacentHTML("beforeend", html.join(""));
        attachSectionHoverPreviews(grid);
        return end - start;
    }

    function renderCards(templates) {
        var grid = document.getElementById(resolveSectionGridId());
        if (!grid) return;

        templates = templates || [];
        var sec = (typeof currentSection !== "undefined" ? currentSection : root.currentSection);
        var sectionsObj = (typeof SECTIONS !== "undefined" ? SECTIONS : (root.SECTIONS || {}));
        var isTxt = (typeof isTextSection === "function") ? isTextSection : (root.isTextSection || function () { return false; });
        var isImg = (typeof isImageSection === "function") ? isImageSection : (root.isImageSection || function () { return false; });
        var bulkSelected = (typeof tmpBulkSelected !== "undefined" ? tmpBulkSelected : (root.tmpBulkSelected || []));
        var domObj = (typeof DOM !== "undefined" ? DOM : (root.DOM || {}));

        if (templates.length === 0) {
            var sb = domObj["search-box"];
            var isS = sb && sb.value && sb.value.trim();
            var hint = "Press Ctrl+S to save one";
            if (sec === sectionsObj.COMP) hint = "Open or select a comp & save";
            else if (sec === sectionsObj.TEXT_PROPS) hint = "Select one text layer & save properties";
            else if (sec === sectionsObj.TEXT) hint = "Select text layer(s) & save";
            else if (sec === sectionsObj.FOOTAGE) hint = "Select footage layer(s) & save";
            else if (sec === sectionsObj.EFFECT) hint = "Select layer or effect(s) & save";
            else if (isImg(sec)) hint = "Select image in AE & save";

            var vg = (typeof VirtualGrid !== "undefined" ? VirtualGrid : root.VirtualGrid);
            var vgHas = (typeof hasVGrid === "function") ? hasVGrid() : (vg && typeof TemplateCatalog !== "undefined");
            if (vgHas && vg.forget) vg.forget(resolveSectionGridId());

            grid.innerHTML =
                '<div class="tpl-empty-state cs-empty-state">' +
                '<span class="cs-empty-state__icon" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg>' +
                "</span>" +
                '<p class="cs-empty-state__title">' +
                (isS ? "No results found" : "No templates yet") + "</p>" +
                '<p class="cs-empty-state__text">' +
                (isS ? "Try a different search" : hint) + "</p></div>";
            return;
        }

        var gridId = resolveSectionGridId();
        var vg = (typeof VirtualGrid !== "undefined" ? VirtualGrid : root.VirtualGrid);
        var vgHas = (typeof hasVGrid === "function") ? hasVGrid() : (vg && typeof TemplateCatalog !== "undefined");

        if (!vgHas) {
            var htmlOld = [];
            for (var o = 0; o < templates.length; o++) {
                htmlOld.push(renderTemplateCardMarkup(templates[o], sec, bulkSelected));
            }
            grid.innerHTML = htmlOld.join("");
            attachSectionHoverPreviews(grid);
            return;
        }

        var ids = [];
        for (var i = 0; i < templates.length; i++) {
            if (templates[i].id !== undefined && templates[i].id !== null) ids.push(templates[i].id);
        }
        vg.render(gridId, grid, gridId + "|direct", ids, {
            section: sec,
            selectedKeys: bulkSelected,
            onPainted: function (mountedGrid) {
                attachSectionHoverPreviews(mountedGrid);
            }
        });
    }

    var api = {
        escapeTemplateCardAttribute: escapeTemplateCardAttribute,
        renderTemplateCardMarkup: renderTemplateCardMarkup,
        resolveSectionGridId: resolveSectionGridId,
        sectionUsesHoverPreviews: sectionUsesHoverPreviews,
        attachSectionHoverPreviews: attachSectionHoverPreviews,
        renderCardsFirstBatch: renderCardsFirstBatch,
        appendCardBatch: appendCardBatch,
        renderCards: renderCards,
        TEMPLATE_FIRST_BATCH: TEMPLATE_FIRST_BATCH,
        TEMPLATE_APPEND_BATCH: TEMPLATE_APPEND_BATCH
    };

    root.TemplateCardView = api;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
