// ============================================================
// core/keyedMediaCardHelper.js — media-only keyed DOM adapter
// ============================================================
(function (root) {
    "use strict";

    var APPROVED_PATCH_FIELDS = {
        thumbnail: true,
        thumbnailPath: true,
        thumbStatus: true,
        _isPending: true,
        mediaPath: true,
        mediaFile: true,
        proxyFile: true,
        mediaType: true,
        terminalState: true,
        derivativeStatus: true
    };

    function own(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    }

    function stableId(value) {
        if (value === undefined || value === null) return null;
        value = "" + value;
        return value ? value : null;
    }

    function registryKey(id) {
        return "$" + id;
    }

    function normalizePath(value) {
        return ("" + (value || "")).replace(/\\/g, "/");
    }

    function toFileUrl(value) {
        var path = normalizePath(value);
        if (!path || /^file:\/\/\//i.test(path) || /^(data|blob):/i.test(path)) return path;
        if (path.charAt(0) === "/") path = path.substring(1);
        return "file:///" + encodeURI(path);
    }

    function KeyedMediaCardHelper(options) {
        if (!(this instanceof KeyedMediaCardHelper)) return new KeyedMediaCardHelper(options);
        options = options || {};
        this._document = options.document || root.document || null;
        this._renderCardMarkup = options.renderCardMarkup || root.renderTemplateCardMarkup || null;
        this._metrics = options.metrics || null;
        this._onFailedUpdate = options.onFailedUpdate || null;
        this._registry = {};
        this._disposed = false;
    }

    KeyedMediaCardHelper.prototype._report = function (ok, reason, error) {
        try {
            if (this._metrics && typeof this._metrics.recordCardPatch === "function") {
                this._metrics.recordCardPatch(ok);
            }
        } catch (ignoreMetrics) { }
        if (!ok) {
            try {
                if (typeof this._onFailedUpdate === "function") this._onFailedUpdate(reason, error || null);
            } catch (ignoreReporter) { }
        }
    };

    KeyedMediaCardHelper.prototype._failure = function (reason, error) {
        this._report(false, reason, error);
        return { ok: false, reason: reason, error: error || null };
    };

    KeyedMediaCardHelper.prototype._isAttached = function (card) {
        if (!card) return false;
        if (typeof card.isConnected === "boolean") return card.isConnected;
        var doc = card.ownerDocument || this._document;
        if (doc && doc.documentElement && typeof doc.documentElement.contains === "function") {
            return doc.documentElement.contains(card);
        }
        var node = card;
        while (node) {
            if (node === doc || (doc && node === doc.documentElement)) return true;
            node = node.parentNode;
        }
        return false;
    };

    KeyedMediaCardHelper.prototype._cardFromMarkup = function (entry, expectedId) {
        var doc = this._document;
        if (!doc || typeof doc.createElement !== "function" || typeof this._renderCardMarkup !== "function") {
            return { ok: false, reason: "markup-unavailable" };
        }
        var holder = doc.createElement("div");
        var markup;
        try {
            markup = this._renderCardMarkup(entry, entry.section || entry.type || "", []);
            if (typeof markup !== "string") return { ok: false, reason: "invalid-markup" };
            holder.innerHTML = markup;
        } catch (error) {
            return { ok: false, reason: "markup-failed", error: error };
        }
        var children = holder.children;
        if (!children || children.length !== 1) return { ok: false, reason: "invalid-card-root" };
        var card = children[0];
        if (!card || card.id !== expectedId) return { ok: false, reason: "identity-mismatch" };
        var thumbs = typeof card.querySelectorAll === "function" ? card.querySelectorAll(".thumb-img") : [];
        if (!thumbs || thumbs.length !== 1) return { ok: false, reason: "thumbnail-count" };
        return { ok: true, card: card };
    };

    KeyedMediaCardHelper.prototype.register = function (id, card) {
        id = stableId(id);
        if (this._disposed) return this._failure("disposed");
        if (id === null || !card) return this._failure("invalid-registration");
        if (card.id !== "tpl-" + id) return this._failure("identity-mismatch");
        var key = registryKey(id);
        if (own(this._registry, key)) return this._failure("duplicate-registration");
        this._registry[key] = card;
        return { ok: true, id: id, card: card };
    };

    // FIX 8b — insertBatch used to be all-or-nothing over its PER-ENTRY
    // pre-checks: one already-registered id, or one entry whose markup could not
    // be built, returned `{ ok:false }` for the whole batch and the user saw
    // ZERO cards for 100 good files. Those checks now skip the offending entry
    // and continue.
    //
    // What did NOT change: the atomic-rollback guarantee for the DOM append.
    // If `grid.appendChild` throws, or a card does not land under the requested
    // grid, every card this call added is still removed and the call still
    // reports `{ ok:false, reason:"insert-failed" }`. That is the guarantee the
    // suites pin, and a partially attached fragment is a real DOM fault rather
    // than one bad entry.
    //
    // The reply is also unchanged whenever NOTHING could be inserted: the first
    // skip's reason is returned as the batch reason, so a single-entry batch
    // still answers `{ ok:false, reason:"duplicate-registration" }` /
    // `"duplicate-card"` / `"thumbnail-count"` exactly as before. Skips are
    // reported through `onFailedUpdate` / `recordCardPatch(false)` one per
    // skipped entry, keeping the "exactly one failed update" counter identity
    // for the single-entry case.
    //
    // `skipped` is additive: `[{ index, id, reason, error }]` so a caller can
    // surface which entries did not make it and why.
    KeyedMediaCardHelper.prototype.insertBatch = function (entries, grid) {
        if (this._disposed) return this._failure("disposed");
        if (!entries || Object.prototype.toString.call(entries) !== "[object Array]") {
            return this._failure("invalid-batch");
        }
        if (!grid || typeof grid.appendChild !== "function") return this._failure("invalid-grid");
        var doc = this._document;
        if (!doc || typeof doc.createDocumentFragment !== "function") return this._failure("document-unavailable");

        var fragment = doc.createDocumentFragment();
        var cards = [];
        var ids = [];
        var skipped = [];
        var pending = {};
        var self = this;
        var i;

        function skip(index, id, reason, error) {
            skipped.push({ index: index, id: id, reason: reason, error: error || null });
            self._report(false, reason, error || null);
        }

        for (i = 0; i < entries.length; i++) {
            var entry = entries[i];
            var id = entry && stableId(entry.id);
            if (id === null) { skip(i, null, "invalid-id", null); continue; }
            var key = registryKey(id);
            // A duplicate is not an error: the card already exists.
            if (own(pending, key) || own(this._registry, key)) { skip(i, id, "duplicate-registration", null); continue; }
            if (doc.getElementById && doc.getElementById("tpl-" + id)) { skip(i, id, "duplicate-card", null); continue; }
            var built = this._cardFromMarkup(entry, "tpl-" + id);
            // A genuine markup fault (markup-failed / invalid-card-root /
            // identity-mismatch / thumbnail-count) also skips rather than
            // discarding the other entries; the reason travels back in `skipped`.
            if (!built.ok) { skip(i, id, built.reason, built.error); continue; }
            pending[key] = true;
            ids.push(id);
            cards.push(built.card);
            fragment.appendChild(built.card);
        }

        // Every entry was skipped: report it as the batch failure the callers
        // already handle, carrying the first reason. The skips were reported
        // individually above, so no second report is emitted here.
        if (entries.length && !cards.length) {
            return { ok: false, reason: skipped[0].reason, error: skipped[0].error, skipped: skipped };
        }

        try {
            grid.appendChild(fragment);
            for (i = 0; i < cards.length; i++) {
                if (cards[i].parentNode !== grid) throw new Error("Card was not attached to the requested grid");
            }
        } catch (error) {
            for (i = 0; i < cards.length; i++) {
                try {
                    if (cards[i].parentNode) cards[i].parentNode.removeChild(cards[i]);
                } catch (ignoreRollback) { }
            }
            var rolledBack = this._failure("insert-failed", error);
            rolledBack.skipped = skipped;
            return rolledBack;
        }

        for (i = 0; i < ids.length; i++) this._registry[registryKey(ids[i])] = cards[i];
        return { ok: true, ids: ids, cards: cards, skipped: skipped };
    };

    function validatePatch(patch) {
        if (!patch || typeof patch !== "object" || Object.prototype.toString.call(patch) === "[object Array]") return false;
        var keys = [];
        var key;
        for (key in patch) {
            if (!own(patch, key) || !APPROVED_PATCH_FIELDS[key]) return false;
            keys.push(key);
        }
        if (!keys.length) return false;
        if (own(patch, "thumbnail") && own(patch, "thumbnailPath")) return false;
        var mediaCount = (own(patch, "mediaPath") ? 1 : 0) + (own(patch, "mediaFile") ? 1 : 0) + (own(patch, "proxyFile") ? 1 : 0);
        if (mediaCount > 1) return false;
        if (own(patch, "_isPending") && typeof patch._isPending !== "boolean") return false;
        if (own(patch, "thumbStatus") && ["placeholder", "rendering", "ready", "failed"].indexOf(patch.thumbStatus) === -1) return false;
        if (own(patch, "terminalState") && ["pending", "ready", "failed"].indexOf(patch.terminalState) === -1) return false;
        for (var i = 0; i < keys.length; i++) {
            var value = patch[keys[i]];
            if (value !== null && value !== undefined && typeof value !== "string" && typeof value !== "boolean") return false;
        }
        return true;
    }

    function addAttributeOperation(operations, target, name, value, remove) {
        var oldValue = target.getAttribute(name);
        var hadValue = typeof target.hasAttribute === "function" ? target.hasAttribute(name) : oldValue !== null;
        operations.push({
            kind: "attribute",
            target: target,
            name: name,
            remove: !!remove,
            value: value,
            hadValue: hadValue,
            oldValue: oldValue
        });
    }

    function applyOperation(operation, rollback) {
        if (operation.kind === "className") {
            operation.target.className = rollback ? operation.oldValue : operation.value;
            return;
        }
        if (rollback) {
            if (operation.hadValue) operation.target.setAttribute(operation.name, operation.oldValue);
            else operation.target.removeAttribute(operation.name);
        } else if (operation.remove) {
            operation.target.removeAttribute(operation.name);
        } else {
            operation.target.setAttribute(operation.name, operation.value);
        }
    }

    function classTokens(value) {
        var source = ("" + (value || "")).split(/\s+/);
        var result = [];
        for (var i = 0; i < source.length; i++) if (source[i] && result.indexOf(source[i]) === -1) result.push(source[i]);
        return result;
    }

    function setClass(tokens, name, enabled) {
        var index = tokens.indexOf(name);
        if (enabled && index === -1) tokens.push(name);
        else if (!enabled && index !== -1) tokens.splice(index, 1);
    }

    KeyedMediaCardHelper.prototype.patchById = function (id, patch) {
        id = stableId(id);
        if (this._disposed) return this._failure("disposed");
        if (id === null) return this._failure("invalid-id");
        var key = registryKey(id);
        if (!own(this._registry, key)) return this._failure("missing-registration");
        var card = this._registry[key];
        if (!card) return this._failure("missing-card");
        if (card.id !== "tpl-" + id) return this._failure("identity-mismatch");
        if (!this._isAttached(card)) {
            // A windowed grid (js/templates/virtualGrid.js) repaints by replacing
            // the grid's children, so the exact node registered at insert time is
            // swapped for a freshly parsed one carrying the same DOM id. The
            // record is still on screen; only the element identity moved. Adopt
            // the live node rather than reporting the patch as failed, otherwise
            // every thumbnail/terminal-state patch after the first repaint is
            // dropped and the cards stay stuck in their pending look.
            var live = this._document && typeof this._document.getElementById === "function" ?
                this._document.getElementById("tpl-" + id) : null;
            if (!live || live === card || !this._isAttached(live)) return this._failure("detached-card");
            this._registry[key] = live;
            card = live;
        }
        if (!validatePatch(patch)) return this._failure("invalid-patch");
        if (typeof card.querySelectorAll !== "function") return this._failure("invalid-card");

        var thumbs;
        try { thumbs = card.querySelectorAll(".thumb-img"); }
        catch (queryError) { return this._failure("thumbnail-query-failed", queryError); }
        if (!thumbs || thumbs.length !== 1) return this._failure("thumbnail-count");
        var image = thumbs[0];
        if (!image || typeof image.getAttribute !== "function" || typeof image.setAttribute !== "function" ||
            typeof image.removeAttribute !== "function" || typeof card.getAttribute !== "function" ||
            typeof card.setAttribute !== "function" || typeof card.removeAttribute !== "function") {
            return this._failure("invalid-card");
        }

        var operations = [];
        var hasThumbnail = own(patch, "thumbnail") || own(patch, "thumbnailPath");
        if (hasThumbnail) {
            var thumbnail = own(patch, "thumbnail") ? patch.thumbnail : patch.thumbnailPath;
            thumbnail = thumbnail === null || thumbnail === undefined ? "" : toFileUrl(thumbnail);
            addAttributeOperation(operations, card, "data-thumb", thumbnail, false);
            addAttributeOperation(operations, image, "src", thumbnail, !thumbnail);
        }
        if (own(patch, "mediaPath") || own(patch, "mediaFile") || own(patch, "proxyFile")) {
            var mediaValue = own(patch, "mediaPath") ? patch.mediaPath : (own(patch, "proxyFile") ? patch.proxyFile : patch.mediaFile);
            addAttributeOperation(operations, card, "data-mediapath", normalizePath(mediaValue), false);
        }
        if (own(patch, "mediaType")) addAttributeOperation(operations, card, "data-mediatype", "" + (patch.mediaType || ""), false);
        if (own(patch, "thumbStatus")) addAttributeOperation(operations, card, "data-thumbstatus", patch.thumbStatus, false);
        if (own(patch, "terminalState")) addAttributeOperation(operations, card, "data-terminalstate", patch.terminalState, false);
        if (own(patch, "derivativeStatus")) {
            addAttributeOperation(operations, card, "data-derivativestatus", "" + (patch.derivativeStatus || ""), false);
        }

        var tokens = classTokens(card.className);
        if (own(patch, "_isPending")) setClass(tokens, "media-pending", patch._isPending);
        if (own(patch, "thumbStatus")) {
            setClass(tokens, "thumb-failed", patch.thumbStatus === "failed");
            if (!own(patch, "_isPending") && (patch.thumbStatus === "ready" || patch.thumbStatus === "failed")) {
                setClass(tokens, "media-pending", false);
            }
        }
        if (own(patch, "terminalState")) {
            setClass(tokens, "media-pending", patch.terminalState === "pending");
            if (patch.terminalState === "failed") setClass(tokens, "thumb-failed", true);
        }
        var nextClassName = tokens.join(" ");
        if (nextClassName !== card.className) {
            operations.push({ kind: "className", target: card, value: nextClassName, oldValue: card.className });
        }

        var applied = 0;
        try {
            for (applied = 0; applied < operations.length; applied++) applyOperation(operations[applied], false);
        } catch (applicationError) {
            for (var rollback = applied; rollback >= 0; rollback--) {
                if (rollback >= operations.length) continue;
                try { applyOperation(operations[rollback], true); } catch (ignoreRollback) { }
            }
            return this._failure("patch-application-failed", applicationError);
        }

        this._report(true, null, null);
        return { ok: true, id: id, card: card, image: image };
    };

    KeyedMediaCardHelper.prototype.unregister = function (id) {
        id = stableId(id);
        if (id === null) return false;
        var key = registryKey(id);
        if (!own(this._registry, key)) return false;
        delete this._registry[key];
        return true;
    };

    KeyedMediaCardHelper.prototype.dispose = function () {
        this._registry = {};
        this._disposed = true;
    };

    function createKeyedMediaCardHelper(options) {
        return new KeyedMediaCardHelper(options);
    }

    root.KeyedMediaCardHelper = KeyedMediaCardHelper;
    root.createKeyedMediaCardHelper = createKeyedMediaCardHelper;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            KeyedMediaCardHelper: KeyedMediaCardHelper,
            createKeyedMediaCardHelper: createKeyedMediaCardHelper,
            APPROVED_PATCH_FIELDS: APPROVED_PATCH_FIELDS
        };
    }
})(typeof window !== "undefined" ? window : (typeof global !== "undefined" ? global : this));
