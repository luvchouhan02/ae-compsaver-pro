// Reusable, CEP-safe collection derivation and keyed commit controller.
// Domain records, persistence formats, bridge calls, and preview queues remain external.
(function (root, factory) {
    "use strict";
    var api = factory(root);
    root.CollectionController = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
    "use strict";

    var SOURCE_STATES = ["loading", "ready", "unavailable", "unreadable", "placeholder"];
    var VIEW_KINDS = ["loading", "ready", "true-empty", "filtered-empty", "unavailable", "unreadable", "placeholder"];
    var CARD_SIZES = ["small", "medium", "large"];
    var DENSITIES = ["compact", "expanded"];
    var SORTS = ["default", "name-asc", "name-desc"];
    var DEFAULT_DEBOUNCE = 150;
    var MIN_DEBOUNCE = 50;
    var MAX_DEBOUNCE = 500;

    function error(code, detail) {
        var value = new Error(code + (detail ? ": " + detail : ""));
        value.code = code;
        return value;
    }

    function contains(values, value) {
        return values.indexOf(value) !== -1;
    }

    function copyArray(value) {
        return value ? value.slice(0) : [];
    }

    function copyObject(value) {
        var result = {};
        value = value || {};
        for (var key in value) {
            if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = value[key];
        }
        return result;
    }

    function normalizeId(value) {
        if ((typeof value !== "string" && typeof value !== "number") ||
            (typeof value === "number" && !isFinite(value))) {
            throw error("COLLECTION_ID_INVALID");
        }
        var id = String(value);
        if (!id.length) throw error("COLLECTION_ID_MISSING");
        return id;
    }

    function validateEnum(value, values, code) {
        if (!contains(values, value)) throw error(code, String(value));
        return value;
    }

    function validateDebounce(value) {
        if (typeof value !== "number" || !isFinite(value) ||
            value < MIN_DEBOUNCE || value > MAX_DEBOUNCE) {
            throw error("SEARCH_DEBOUNCE_INVALID", String(value));
        }
        return value;
    }

    function recordEntries(records, getId) {
        if (!Array.isArray(records)) throw error("COLLECTION_RECORDS_INVALID");
        var entries = [];
        var seen = Object.create(null);
        for (var i = 0; i < records.length; i++) {
            var record = records[i];
            var id = normalizeId(getId(record, i));
            if (seen[id]) throw error("COLLECTION_ID_DUPLICATE", id);
            seen[id] = true;
            entries.push({ id: id, record: record, sourceIndex: i });
        }
        return entries;
    }
    function defaultSearchText(record) {
        if (!record || typeof record !== "object") return String(record || "");
        return [record.name, record.kind, record.type, record.category]
            .filter(function (value) { return value !== undefined && value !== null; })
            .join(" ");
    }

    function matchesFilters(record, filters) {
        for (var key in filters) {
            if (!Object.prototype.hasOwnProperty.call(filters, key)) continue;
            var expected = filters[key];
            if (expected === null || expected === undefined || expected === "*" ||
                (Array.isArray(expected) && !expected.length)) continue;
            var actual = record ? record[key] : undefined;
            if (Array.isArray(expected)) {
                if (expected.indexOf(actual) === -1) return false;
            } else if (actual !== expected) {
                return false;
            }
        }
        return true;
    }

    function compareNames(direction) {
        return function (left, right) {
            var a = String(left && left.name || "").toLocaleLowerCase();
            var b = String(right && right.name || "").toLocaleLowerCase();
            if (a < b) return -1 * direction;
            if (a > b) return 1 * direction;
            return 0;
        };
    }

    function deriveCollection(records, options) {
        options = options || {};
        var getId = typeof options.getId === "function" ? options.getId : function (record) {
            return record && record.id;
        };
        var entries = recordEntries(records, getId);
        var query = String(options.query || "").toLocaleLowerCase();
        var filters = copyObject(options.filters);
        var searchText = typeof options.getSearchText === "function" ? options.getSearchText : defaultSearchText;
        var predicate = typeof options.predicate === "function" ? options.predicate : null;
        var visible = entries.filter(function (entry) {
            if (query && String(searchText(entry.record, entry.id) || "").toLocaleLowerCase().indexOf(query) === -1) {
                return false;
            }
            if (!matchesFilters(entry.record, filters)) return false;
            return !predicate || predicate(entry.record, filters, entry.id);
        });

        var sort = options.sort || "default";
        var comparator = null;
        if (typeof sort === "function") comparator = sort;
        else {
            validateEnum(sort, SORTS, "COLLECTION_SORT_INVALID");
            if (sort === "name-asc") comparator = compareNames(1);
            if (sort === "name-desc") comparator = compareNames(-1);
            if (options.sorters && typeof options.sorters[sort] === "function") {
                comparator = options.sorters[sort];
            }
        }
        if (comparator) {
            visible = visible.slice(0).sort(function (left, right) {
                var value = comparator(left.record, right.record, left.id, right.id);
                return value || left.sourceIndex - right.sourceIndex;
            });
        }
        return {
            entries: visible,
            allIds: entries.map(function (entry) { return entry.id; }),
            visibleIds: visible.map(function (entry) { return entry.id; })
        };
    }

    var VIEW_COPY = {
        "loading": ["loading", "Loading collection", "Items are being loaded.", null],
        "ready": ["ready", "Collection ready", "Items are available.", null],
        "true-empty": ["empty", "Library is empty", "Add or import an item to get started.", ["create-or-import", "Add or import"]],
        "filtered-empty": ["filtered-empty", "No matching items", "Change or clear the current search and filters.", ["clear-filters", "Clear filters"]],
        "unavailable": ["unavailable", "Library unavailable", "Choose an available library location.", ["choose-library-path", "Choose library"]],
        "unreadable": ["unreadable", "Library cannot be read", "Check access and try reading the library again.", ["retry-read", "Try again"]],
        "placeholder": ["placeholder", "Item is being prepared", "The item remains reachable while its media is prepared.", ["retry-media", "Retry media"]]
    };

    function createViewModel(input) {
        input = input || {};
        var sourceState = validateEnum(input.sourceState || "ready", SOURCE_STATES, "COLLECTION_STATE_INVALID");
        var derived = input.derived || { entries: [], allIds: [], visibleIds: [] };
        var kind = sourceState;
        if (sourceState === "ready") {
            kind = derived.allIds.length === 0 ? "true-empty" :
                (derived.visibleIds.length === 0 ? "filtered-empty" : "ready");
        }
        validateEnum(kind, VIEW_KINDS, "COLLECTION_VIEW_KIND_INVALID");
        var content = VIEW_COPY[kind];
        var selectedIds = copyArray(input.selectedIds);
        var visibleSelection = selectedIds.filter(function (id) {
            return derived.visibleIds.indexOf(id) !== -1;
        });
        return {
            kind: kind,
            status: content[0],
            title: content[1],
            message: content[2],
            action: content[3] ? { id: content[3][0], label: content[3][1] } : null,
            generation: input.generation || 0,
            allIds: copyArray(derived.allIds),
            visibleIds: copyArray(derived.visibleIds),
            selectedIds: selectedIds,
            visibleSelectedIds: visibleSelection,
            entries: copyArray(derived.entries),
            query: String(input.query || ""),
            filters: copyObject(input.filters),
            sort: input.sort || "default",
            cardSize: validateEnum(input.cardSize || "small", CARD_SIZES, "CARD_SIZE_INVALID"),
            density: validateEnum(input.density || "compact", DENSITIES, "DENSITY_INVALID"),
            isEmpty: kind === "true-empty" || kind === "filtered-empty",
            isPlaceholder: kind === "placeholder"
        };
    }

    function stableFingerprint(value, stack) {
        if (value === null) return "null";
        var type = typeof value;
        if (type !== "object") return type + ":" + String(value);
        stack = stack || [];
        if (stack.indexOf(value) !== -1) return "[circular]";
        stack.push(value);
        var result;
        if (Array.isArray(value)) {
            result = "[" + value.map(function (item) { return stableFingerprint(item, stack); }).join(",") + "]";
        } else {
            var keys = Object.keys(value).sort();
            result = "{" + keys.map(function (key) {
                return key + ":" + stableFingerprint(value[key], stack);
            }).join(",") + "}";
        }
        stack.pop();
        return result;
    }
    function readExisting(container) {
        var children = container && container.children ? Array.prototype.slice.call(container.children) : [];
        var existing = [];
        var seen = Object.create(null);
        for (var i = 0; i < children.length; i++) {
            var node = children[i];
            var raw = node.getAttribute ? node.getAttribute("data-collection-key") : null;
            if (raw === null || raw === undefined || raw === "") {
                existing.push({ key: null, node: node, fingerprint: node._csCollectionFingerprint });
                continue;
            }
            var key = normalizeId(raw);
            if (seen[key]) throw error("DOM_COLLECTION_KEY_DUPLICATE", key);
            seen[key] = true;
            existing.push({ key: key, node: node, fingerprint: node._csCollectionFingerprint });
        }
        return existing;
    }

    function planKeyedCommit(existing, viewModel, fingerprint) {
        if (!viewModel || !Array.isArray(viewModel.entries)) throw error("COLLECTION_VIEW_MODEL_INVALID");
        var desired = [];
        var desiredSeen = Object.create(null);
        var selected = Object.create(null);
        viewModel.selectedIds.forEach(function (id) { selected[id] = true; });
        for (var i = 0; i < viewModel.entries.length; i++) {
            var entry = viewModel.entries[i];
            var key = normalizeId(entry.id);
            if (desiredSeen[key]) throw error("COLLECTION_ID_DUPLICATE", key);
            desiredSeen[key] = true;
            var calculated = fingerprint ? fingerprint(entry.record, key, viewModel) :
                stableFingerprint(entry.record) + "|selected:" + Boolean(selected[key]) +
                "|size:" + viewModel.cardSize + "|density:" + viewModel.density;
            desired.push({ key: key, record: entry.record, fingerprint: String(calculated), node: null });
        }

        var byKey = Object.create(null);
        var removals = [];
        existing.forEach(function (item) {
            if (item.key === null || !desiredSeen[item.key]) removals.push(item);
            else byKey[item.key] = item;
        });
        desired.forEach(function (item) {
            if (byKey[item.key]) item.node = byKey[item.key].node;
        });

        var simulated = existing.filter(function (item) {
            return item.key !== null && desiredSeen[item.key];
        }).map(function (item) {
            return desired.filter(function (target) { return target.key === item.key; })[0];
        });
        var placements = [];
        for (var index = 0; index < desired.length; index++) {
            var target = desired[index];
            var currentIndex = -1;
            for (var j = 0; j < simulated.length; j++) {
                if (simulated[j].key === target.key) { currentIndex = j; break; }
            }
            if (currentIndex === index) continue;
            var before = simulated[index] || null;
            if (currentIndex !== -1) simulated.splice(currentIndex, 1);
            simulated.splice(index, 0, target);
            placements.push({ item: target, before: before });
        }
        var patches = desired.filter(function (item) {
            return item.node && byKey[item.key].fingerprint !== item.fingerprint;
        });
        return { desired: desired, removals: removals, placements: placements, patches: patches };
    }

    function commitKeyed(container, viewModel, adapter) {
        if (!container || typeof container.insertBefore !== "function" || typeof container.removeChild !== "function") {
            throw error("COLLECTION_CONTAINER_INVALID");
        }
        adapter = adapter || {};
        if (typeof adapter.create !== "function") throw error("COLLECTION_ADAPTER_CREATE_REQUIRED");
        var existing = readExisting(container); // Complete read phase before any write.
        var plan = planKeyedCommit(existing, viewModel, adapter.fingerprint);
        var created = [];
        var moved = [];
        var removed = [];
        var patched = [];

        plan.removals.forEach(function (item) {
            container.removeChild(item.node);
            removed.push(item.key);
        });
        plan.placements.forEach(function (placement) {
            var item = placement.item;
            if (!item.node) {
                item.node = adapter.create(item.record, item.key, viewModel);
                if (!item.node) throw error("COLLECTION_ADAPTER_CREATE_FAILED", item.key);
                if (item.node.setAttribute) item.node.setAttribute("data-collection-key", item.key);
                item.node._csCollectionFingerprint = item.fingerprint;
                created.push(item.key);
            } else {
                moved.push(item.key);
            }
            container.insertBefore(item.node, placement.before ? placement.before.node : null);
        });
        plan.patches.forEach(function (item) {
            if (typeof adapter.patch === "function") adapter.patch(item.node, item.record, item.key, viewModel);
            item.node._csCollectionFingerprint = item.fingerprint;
            patched.push(item.key);
        });
        return { created: created, moved: moved, patched: patched, removed: removed };
    }

    function makeScheduler(value) {
        value = value || {};
        var set = value.setTimeout || root.setTimeout;
        var clear = value.clearTimeout || root.clearTimeout;
        if (typeof set !== "function" || typeof clear !== "function") throw error("COLLECTION_SCHEDULER_INVALID");
        return {
            setTimeout: function (fn, delay) { return set(fn, delay); },
            clearTimeout: function (token) { clear(token); },
            requestFrame: value.requestFrame || function (fn) { return set(fn, 0); },
            cancelFrame: value.cancelFrame || function (token) { clear(token); }
        };
    }

    function settingValue(settings, key, fallback) {
        return settings && typeof settings.get === "function" ? settings.get(key) : fallback;
    }
    function createCollectionController(options) {
        options = options || {};
        var settings = options.settings || root.Settings || null;
        var scheduler = makeScheduler(options.scheduler);
        var cardSizeKey = options.cardSizeSettingKey || "ui.templateCardSize";
        var densityKey = options.densitySettingKey || "ui.density";
        var debounceKey = options.debounceSettingKey || "performance.searchDebounce";
        var state = {
            records: copyArray(options.records),
            sourceState: options.sourceState || "loading",
            query: String(options.query || ""),
            filters: copyObject(options.filters),
            sort: options.sort || "default",
            selectedIds: copyArray(options.selectedIds).map(normalizeId),
            cardSize: settingValue(settings, cardSizeKey, options.cardSize || "small"),
            density: settingValue(settings, densityKey, options.density || "compact"),
            generation: 0
        };
        validateEnum(state.sourceState, SOURCE_STATES, "COLLECTION_STATE_INVALID");
        validateEnum(state.cardSize, CARD_SIZES, "CARD_SIZE_INVALID");
        validateEnum(state.density, DENSITIES, "DENSITY_INVALID");
        if (typeof state.sort !== "function") validateEnum(state.sort, SORTS, "COLLECTION_SORT_INVALID");
        validateDebounce(settingValue(settings, debounceKey, options.searchDebounce === undefined ? DEFAULT_DEBOUNCE : options.searchDebounce));
        var getId = typeof options.getId === "function" ? options.getId : function (record) { return record && record.id; };
        var initialEntries = recordEntries(state.records, getId);
        var initialAvailable = Object.create(null);
        var initialSelected = Object.create(null);
        initialEntries.forEach(function (entry) { initialAvailable[entry.id] = true; });
        state.selectedIds = state.selectedIds.filter(function (id) {
            if (!initialAvailable[id] || initialSelected[id]) return false;
            initialSelected[id] = true;
            return true;
        });
        var timer = null;
        var frame = null;
        var disposed = false;
        var lastViewModel = null;
        var unsubscribers = [];

        function cancelScheduled() {
            if (timer !== null) scheduler.clearTimeout(timer);
            if (frame !== null) scheduler.cancelFrame(frame);
            timer = null;
            frame = null;
        }

        function currentDebounce() {
            return validateDebounce(settingValue(settings, debounceKey,
                options.searchDebounce === undefined ? DEFAULT_DEBOUNCE : options.searchDebounce));
        }

        function deriveCurrent() {
            var derived = deriveCollection(state.records, {
                getId: getId,
                getSearchText: options.getSearchText,
                predicate: options.predicate,
                filters: state.filters,
                sort: state.sort,
                sorters: options.sorters,
                query: state.query
            });
            return createViewModel({
                sourceState: state.sourceState,
                derived: derived,
                selectedIds: state.selectedIds,
                generation: state.generation,
                query: state.query,
                filters: state.filters,
                sort: typeof state.sort === "function" ? "custom" : state.sort,
                cardSize: state.cardSize,
                density: state.density
            });
        }

        function commit(capturedGeneration, viewModel) {
            if (disposed || capturedGeneration !== state.generation) return false;
            if (typeof options.commit === "function") options.commit(viewModel);
            else if (options.container && viewModel.kind === "ready") {
                commitKeyed(options.container, viewModel, options.adapter);
            } else if (options.adapter && typeof options.adapter.renderState === "function") {
                options.adapter.renderState(viewModel, options.container || null);
            }
            lastViewModel = viewModel;
            if (typeof options.onCommit === "function") options.onCommit(viewModel);
            return true;
        }

        function schedule(delay) {
            if (disposed) return state.generation;
            cancelScheduled();
            var capturedGeneration = state.generation;
            timer = scheduler.setTimeout(function () {
                timer = null;
                if (disposed || capturedGeneration !== state.generation) return;
                var viewModel = deriveCurrent();
                frame = scheduler.requestFrame(function () {
                    frame = null;
                    commit(capturedGeneration, viewModel);
                });
            }, delay);
            return capturedGeneration;
        }

        function changed(delay) {
            state.generation += 1;
            schedule(delay || 0);
            return state.generation;
        }

        function validRecordIdSet() {
            var values = Object.create(null);
            recordEntries(state.records, getId).forEach(function (entry) { values[entry.id] = true; });
            return values;
        }

        function setSelectedIds(ids) {
            if (!Array.isArray(ids)) throw error("COLLECTION_SELECTION_INVALID");
            var available = validRecordIdSet();
            var seen = Object.create(null);
            var next = [];
            ids.forEach(function (value) {
                var id = normalizeId(value);
                if (available[id] && !seen[id]) { seen[id] = true; next.push(id); }
            });
            state.selectedIds = next;
            return changed(0);
        }

        function observeSetting(key, handler) {
            if (!settings || typeof settings.onChange !== "function") return;
            var unsubscribe = settings.onChange(key, handler);
            if (typeof unsubscribe === "function") unsubscribers.push(unsubscribe);
        }
        observeSetting(cardSizeKey, function (value) {
            state.cardSize = validateEnum(value, CARD_SIZES, "CARD_SIZE_INVALID");
            changed(0);
        });
        observeSetting(densityKey, function (value) {
            state.density = validateEnum(value, DENSITIES, "DENSITY_INVALID");
            changed(0);
        });

        var api = {
            schedule: function () { return schedule(0); },
            flush: function () {
                cancelScheduled();
                var generation = state.generation;
                var viewModel = deriveCurrent();
                commit(generation, viewModel);
                return viewModel;
            },
            setRecords: function (records) {
                var validated = recordEntries(records, getId);
                state.records = copyArray(records);
                var available = Object.create(null);
                validated.forEach(function (entry) { available[entry.id] = true; });
                state.selectedIds = state.selectedIds.filter(function (id) { return available[id]; });
                return changed(0);
            },
            setSourceState: function (value) {
                state.sourceState = validateEnum(value, SOURCE_STATES, "COLLECTION_STATE_INVALID");
                return changed(0);
            },
            setQuery: function (value) {
                var delay = currentDebounce();
                state.query = String(value || "");
                return changed(delay);
            },
            setFilters: function (value) {
                if (!value || typeof value !== "object" || Array.isArray(value)) throw error("COLLECTION_FILTERS_INVALID");
                state.filters = copyObject(value);
                return changed(0);
            },
            setSort: function (value) {
                if (typeof value !== "function") validateEnum(value, SORTS, "COLLECTION_SORT_INVALID");
                state.sort = value;
                return changed(0);
            },
            setCardSize: function (value) {
                state.cardSize = validateEnum(value, CARD_SIZES, "CARD_SIZE_INVALID");
                return changed(0);
            },
            setDensity: function (value) {
                state.density = validateEnum(value, DENSITIES, "DENSITY_INVALID");
                return changed(0);
            },
            setSelectedIds: setSelectedIds,
            toggleSelectedId: function (value) {
                var id = normalizeId(value);
                var next = copyArray(state.selectedIds);
                var index = next.indexOf(id);
                if (index === -1) next.push(id); else next.splice(index, 1);
                return setSelectedIds(next);
            },
            clearSelection: function () { return setSelectedIds([]); },
            getState: function () {
                return {
                    sourceState: state.sourceState, query: state.query, filters: copyObject(state.filters),
                    sort: state.sort, selectedIds: copyArray(state.selectedIds), cardSize: state.cardSize,
                    density: state.density, generation: state.generation, records: copyArray(state.records)
                };
            },
            getViewModel: function () { return lastViewModel; },
            dispose: function () {
                if (disposed) return false;
                disposed = true;
                cancelScheduled();
                unsubscribers.forEach(function (unsubscribe) { try { unsubscribe(); } catch (ignore) { } });
                unsubscribers = [];
                return true;
            }
        };
        if (options.autoRender !== false) schedule(0);
        return api;
    }

    return {
        SOURCE_STATES: copyArray(SOURCE_STATES), VIEW_KINDS: copyArray(VIEW_KINDS),
        CARD_SIZES: copyArray(CARD_SIZES), DENSITIES: copyArray(DENSITIES), SORTS: copyArray(SORTS),
        validateDebounce: validateDebounce, deriveCollection: deriveCollection,
        createViewModel: createViewModel, planKeyedCommit: planKeyedCommit,
        commitKeyed: commitKeyed, create: createCollectionController
    };
});
