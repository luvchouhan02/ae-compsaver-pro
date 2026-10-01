// ============================================================
// templates/templateCatalog.js — normalized template catalog
// ------------------------------------------------------------
// Single-pass index over the template records ("allTemplates"):
//   - byId:            stable id -> record
//   - sectionIds:      section -> ordered record ids (array order =
//                      the exact existing render/sort order)
//   - sectionCatIds:   section -> category -> ordered ids
//   - counts:          section -> { all, favorites, perCategory }
//   - searchHay:       id -> precomputed lowercase haystack
//
// Selection (idsFor) never rescans records; category counting is
// one-pass, not O(N*C). UI mutations (add / rename / move / delete /
// favorite) patch the index incrementally; a structural category
// change recomputes only the affected section's category LIST (order
// parity with a full rescan, cost O(section), frequency: per user
// mutation, not per switch).
//
// CEP-safe ES5, no dependencies; getTemplateSection is injected so the
// module stays loadable in vm-based tests. Load AFTER core/utils.js,
// BEFORE templates.js.
// ============================================================

var TemplateCatalog = (function () {
    "use strict";

    var sectionOf = null;      // injected record -> section resolver
    var byId = {};             // id -> record
    var sectionIds = {};       // section -> [ids] in stable order
    var sectionCatIds = {};    // section -> { category -> [ids] }
    var sectionCats = {};      // section -> [category names] discovery order
    var counts = {};           // section -> { all, favorites, cats: {name:n} }
    var searchHay = {};        // id -> lowercase haystack string

    // ── Source revision stamp ───────────────────────────────────────
    // The catalog indexes records it does NOT own, so a mutation applied to
    // those records from outside is invisible from in here: an in-place field
    // write keeps every object identity, and a wholesale rewrite of the source
    // array (MediaEntryRepository._publishDurable clears the shared mirror and
    // re-pushes fresh CLONES at CONSTANT length) keeps the element count. A
    // caller therefore stamps the source revision the catalog currently
    // reflects and reads it back before rendering, instead of inferring
    // freshness from size() alone — which neither of those cases moves.
    // null = "unknown revision", which a freshness check must treat as stale.
    var sourceRevision = null;

    function recordId(t) {
        return t && t.id !== undefined && t.id !== null ? t.id : null;
    }

    function hayFor(t) {
        return ((t.name || "") + " " + (t.category || "") + " " +
            (t.type || "") + " " + (t.section || "") + " " + (t.dim || "")).toLowerCase();
    }

    function sectionBuckets(section) {
        if (!sectionIds[section]) {
            sectionIds[section] = [];
            sectionCatIds[section] = {};
            sectionCats[section] = [];
            counts[section] = { all: 0, favorites: 0, cats: {} };
        }
    }

    function addToLists(t) {
        var id = recordId(t);
        var section = sectionOf(t);
        var cat = t.category || null;
        sectionBuckets(section);
        sectionIds[section].push(id);
        if (cat) {
            if (!sectionCatIds[section][cat]) {
                sectionCatIds[section][cat] = [];
                sectionCats[section].push(cat);   // discovery order preserved
            }
            sectionCatIds[section][cat].push(id);
            counts[section].cats[cat] = (counts[section].cats[cat] || 0) + 1;
        }
        counts[section].all++;
        if (t.favorite) counts[section].favorites++;
        searchHay[id] = hayFor(t);
        byId[id] = t;
    }

    function removeFromLists(t, idOverride) {
        var id = idOverride !== undefined && idOverride !== null ? idOverride : recordId(t);
        var section = sectionOf(t);
        var cat = t.category || null;
        var ids = sectionIds[section];
        var i = ids.indexOf(id);
        if (i !== -1) ids.splice(i, 1);
        if (cat && sectionCatIds[section] && sectionCatIds[section][cat]) {
            var catIds = sectionCatIds[section][cat];
            var j = catIds.indexOf(id);
            if (j !== -1) catIds.splice(j, 1);
            counts[section].cats[cat] = (counts[section].cats[cat] || 1) - 1;
            if (counts[section].cats[cat] <= 0 || catIds.length === 0) {
                delete sectionCatIds[section][cat];
                delete counts[section].cats[cat];
                var k = sectionCats[section].indexOf(cat);
                if (k !== -1) sectionCats[section].splice(k, 1);
            }
        }
        counts[section].all = Math.max(0, counts[section].all - 1);
        if (t.favorite) counts[section].favorites = Math.max(0, counts[section].favorites - 1);
        delete searchHay[id];
        delete byId[id];
    }

    function clear() {
        byId = {}; sectionIds = {}; sectionCatIds = {}; sectionCats = {}; counts = {}; searchHay = {};
        sourceRevision = null;
    }

    // `revision` (optional) is the caller's source revision this build reflects.
    // Omitting it leaves the stamp null, so a build with no stamp always reads
    // back as stale rather than falsely fresh.
    function build(records, sectionResolver, revision) {
        if (typeof sectionResolver === "function") sectionOf = sectionResolver;
        clear();
        if (!sectionOf) return;
        for (var i = 0; i < records.length; i++) addToLists(records[i]);
        stampSource(revision);
    }

    // Record / read the source revision the catalog currently reflects. Callers
    // that keep the catalog in sync incrementally (patch/remove) re-stamp; a
    // caller comparing its own revision against sourceStamp() knows whether an
    // in-place or same-length mutation has landed since the last sync.
    function stampSource(revision) {
        sourceRevision = (revision === undefined) ? null : revision;
        return sourceRevision;
    }

    function sourceStamp() {
        return sourceRevision;
    }

    // Recompute ONE section's category list from its current record order —
    // used after structural mutations (add/rename/move) so the visible order
    // matches what a full rescan would produce, without touching other
    // sections or rescanning the whole library.
    function rebuildSectionCategories(section) {
        if (!sectionIds[section]) return;
        var ids = sectionIds[section];
        var catIds = {};
        var catOrder = [];
        var catCounts = {};
        var fav = 0;
        for (var i = 0; i < ids.length; i++) {
            var t = byId[ids[i]];
            if (!t) continue;
            var cat = t.category || null;
            if (cat) {
                if (!catIds[cat]) { catIds[cat] = []; catOrder.push(cat); }
                catIds[cat].push(ids[i]);
                catCounts[cat] = (catCounts[cat] || 0) + 1;
            }
            if (t.favorite) fav++;
        }
        sectionCatIds[section] = catIds;
        sectionCats[section] = catOrder;
        counts[section].cats = catCounts;
        counts[section].favorites = fav;
        counts[section].all = ids.length;
    }

    // Incremental mutation patch. Pass oldName/oldCat when the record's
    // identity fields changed so list membership moves correctly.
    function patch(t, previous) {
        if (!sectionOf) return;
        var id = recordId(t);
        if (id === null || byId[id] === undefined) {
            var oldKey = null;
            if (previous && previous.id !== undefined && previous.id !== null && byId[previous.id] !== undefined) {
                oldKey = previous.id;
            } else {
                for (var k in byId) {
                    if (Object.prototype.hasOwnProperty.call(byId, k) && byId[k] === t) {
                        oldKey = k;
                        break;
                    }
                }
            }
            if (oldKey !== null && oldKey !== id) {
                var oldRecord = byId[oldKey];
                var oldSec = sectionOf(oldRecord);
                var newSec = sectionOf(t);
                if (oldSec === newSec) {
                    var sIds = sectionIds[oldSec];
                    var pos = sIds ? sIds.indexOf(oldKey) : -1;
                    removeFromLists(oldRecord, oldKey);
                    addToLists(t);
                    if (pos !== -1 && sectionIds[newSec]) {
                        var newPos = sectionIds[newSec].indexOf(id);
                        if (newPos !== -1 && newPos !== pos) {
                            sectionIds[newSec].splice(newPos, 1);
                            sectionIds[newSec].splice(pos, 0, id);
                        }
                    }
                    rebuildSectionCategories(newSec);
                } else {
                    removeFromLists(oldRecord, oldKey);
                    addToLists(t);
                    rebuildSectionCategories(oldSec);
                    rebuildSectionCategories(newSec);
                }
                return;
            }
            addToLists(t);
            rebuildSectionCategories(sectionOf(t));
            return;
        }
        var structural = false;
        var p = previous || byId[id];
        if (p) {
            if ((p.category || null) !== (t.category || null)) structural = true;
            if (sectionOf(p) !== sectionOf(t)) structural = true;
            if (p.favorite !== t.favorite) {
                var sec = sectionOf(t);
                sectionBuckets(sec);
                counts[sec].favorites = Math.max(0, counts[sec].favorites + (t.favorite ? 1 : -1));
            }
        }
        byId[id] = t;
        searchHay[id] = hayFor(t);
        if (structural) {
            if (sectionOf(p) !== sectionOf(t)) {
                // Cross-section move (reconcile paths do a full build; UI
                // moves never change section): membership must be re-added.
                removeFromLists(p, id);
                addToLists(t);
                rebuildSectionCategories(sectionOf(p));
            }
            // Same section: the id keeps its position in sectionIds, so
            // recomputing category lists from that order reproduces exactly
            // what a full rebuild's discovery order would be.
            rebuildSectionCategories(sectionOf(t));
        }
    }

    function remove(t) {
        if (!sectionOf) return;
        var id = recordId(t);
        var existing = byId[id];
        var victim = existing !== undefined ? existing : t;
        var sec = sectionOf(victim);
        removeFromLists(victim);
        rebuildSectionCategories(sec);
    }

    function idsFor(section, category, query) {
        var ids = sectionIds[section] || [];
        var out;
        if (category === "All" || !category) {
            out = ids.slice(0);
        } else if (category === "Favorites") {
            out = [];
            for (var i = 0; i < ids.length; i++) {
                var t = byId[ids[i]];
                if (t && t.favorite) out.push(ids[i]);
            }
        } else {
            var catIds = (sectionCatIds[section] || {})[category];
            out = catIds ? catIds.slice(0) : [];
        }
        if (query) {
            var q = query.toLowerCase();
            var filtered = [];
            for (var j = 0; j < out.length; j++) {
                if (searchHay[out[j]] && searchHay[out[j]].indexOf(q) !== -1) filtered.push(out[j]);
            }
            return filtered;
        }
        return out;
    }

    function categories(section) {
        var order = sectionCats[section] || [];
        var cats = ["All", "Favorites"];
        for (var i = 0; i < order.length; i++) cats.push(order[i]);
        return cats;
    }

    function sectionCounts(section) {
        return counts[section] || { all: 0, favorites: 0, cats: {} };
    }

    function get(id) { return byId[id]; }
    function size() { var n = 0; for (var k in byId) { if (Object.prototype.hasOwnProperty.call(byId, k)) n++; } return n; }

    return {
        build: build,
        patch: patch,
        remove: remove,
        idsFor: idsFor,
        categories: categories,
        sectionCounts: sectionCounts,
        get: get,
        size: size,
        clear: clear,
        stampSource: stampSource,
        sourceStamp: sourceStamp,
        _rebuildSectionCategories: rebuildSectionCategories
    };
})();
