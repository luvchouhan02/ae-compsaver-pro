// ============================================================
// templates/templateActions.js — modal and event action handlers
// ------------------------------------------------------------
// Extracted card interaction delegation, modal dialog controllers
// (save, rename, move, delete, bulk delete), and timeline import triggers.
// ============================================================

(function (root) {
    "use strict";

    function attachGlobalCardDelegation() {
        if (typeof VirtualGrid !== "undefined") {
            var markupFn = (typeof TemplateCardView !== "undefined" && TemplateCardView.renderTemplateCardMarkup)
                ? TemplateCardView.renderTemplateCardMarkup
                : (typeof renderTemplateCardMarkup === "function" ? renderTemplateCardMarkup : null);

            VirtualGrid.init({
                markupFor: markupFn,
                requestAnimationFrame: (typeof window !== "undefined" && window.requestAnimationFrame) ? window.requestAnimationFrame : null
            });
        }
        var cardGrids = ["comp-list-container", "transition-list-container",
            "text-list-container", "footage-list-container", "effect-list-container", "icon-list-container"];
        for (var i = 0; i < cardGrids.length; i++) {
            var grid = document.getElementById(cardGrids[i]);
            if (!grid) continue;

            grid.addEventListener("click", function (e) {
                var card = e.target.closest(".card");
                if (!card) return;

                // Intercept clicks when templates bulk delete mode is active
                var bulkModeActive = (typeof tmpBulkMode !== "undefined" ? tmpBulkMode : root.tmpBulkMode);
                if (bulkModeActive) {
                    e.preventDefault();
                    e.stopPropagation();
                    var bulkList = (typeof tmpBulkSelected !== "undefined" ? tmpBulkSelected : root.tmpBulkSelected);
                    if (!bulkList) { bulkList = []; root.tmpBulkSelected = bulkList; }
                    var key = card.dataset.file + "||" + card.dataset.cat;
                    var idx = bulkList.indexOf(key);
                    if (idx > -1) {
                        bulkList.splice(idx, 1);
                        card.classList.remove("selected-for-delete");
                    } else {
                        bulkList.push(key);
                        card.classList.add("selected-for-delete");
                    }
                    if (typeof updateTmpBulkCount === "function") updateTmpBulkCount();
                    else if (typeof root.updateTmpBulkCount === "function") root.updateTmpBulkCount();
                    return;
                }

                if (e.target.closest(".btn-delete")) {
                    e.stopPropagation();
                    var delFn = (typeof deleteTemplate === "function" ? deleteTemplate : root.deleteTemplate);
                    if (delFn) delFn(card.dataset.file, card.dataset.cat, card.dataset.folder);
                } else if (e.target.closest(".btn-rename")) {
                    e.stopPropagation();
                    var renFn = (typeof openRenameModal === "function" ? openRenameModal : root.openRenameModal);
                    if (renFn) renFn(card);
                } else if (e.target.closest(".btn-move")) {
                    e.stopPropagation();
                    var movFn = (typeof openMoveModal === "function" ? openMoveModal : root.openMoveModal);
                    if (movFn) movFn(card);
                } else if (e.target.closest(".btn-import")) {
                    e.stopPropagation();
                    var impFn = (typeof importCurrentCardToTimeline === "function" ? importCurrentCardToTimeline : root.importCurrentCardToTimeline);
                    if (impFn) impFn(card);
                } else if (e.target.closest(".btn-favorite")) {
                    e.stopPropagation();
                    var favFn = (typeof toggleFavorite === "function" ? toggleFavorite : root.toggleFavorite);
                    if (favFn) favFn(card);
                } else if (e.target.closest(".btn-more")) {
                    e.stopPropagation();
                    var rect = e.target.closest(".btn-more").getBoundingClientRect();
                    var popFn = (typeof openIconRightClickPopup === "function" ? openIconRightClickPopup : root.openIconRightClickPopup);
                    if (popFn) popFn(card, rect.left, rect.bottom);
                } else if (e.target.closest('[data-ta-act="genpreview"]')) {
                    e.stopPropagation();
                    var btn = e.target.closest('[data-ta-act="genpreview"]');
                    btn.classList.add("rendering");
                    btn.textContent = "Rendering...";
                    btn.disabled = true;
                    var aepPath = card.dataset.folder + "/project.aep";
                    var ta = root.TextAnim || (typeof TextAnim !== "undefined" ? TextAnim : null);
                    if (ta && typeof ta.enqueuePreviewRender === "function") {
                        ta.enqueuePreviewRender(aepPath, card.dataset.file, function (err) {
                            btn.classList.remove("rendering");
                            btn.textContent = "Preview";
                            btn.disabled = false;
                            var toastFn = (typeof showToast === "function" ? showToast : root.showToast);
                            if (toastFn) {
                                if (err) toastFn("Preview generation failed", "error");
                                else toastFn("Preview ready", "success");
                            }
                        });
                    }
                } else {
                    // Default action: Single click on the card imports the template
                    if (e.target.closest("button") || e.target.closest("a") || e.target.closest("input") ||
                        e.target.closest(".card-btn-del") || e.target.closest(".card-btn-rename") ||
                        e.target.closest(".card-btn-more") || e.target.closest(".btn-icon")) {
                        return;
                    }

                    e.preventDefault();
                    var defImpFn = (typeof importCurrentCardToTimeline === "function" ? importCurrentCardToTimeline : root.importCurrentCardToTimeline);
                    if (defImpFn) defImpFn(card);
                }
            });

            grid.addEventListener("dblclick", function (e) {
                var card = e.target.closest(".card");
                if (!card) return;
                e.preventDefault();
            });
        }
    }

    var api = {
        attachGlobalCardDelegation: attachGlobalCardDelegation
    };

    root.TemplateActions = api;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
