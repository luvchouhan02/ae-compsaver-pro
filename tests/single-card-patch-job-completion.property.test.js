/**
 * Single-card patch on job completion
 * ===================================
 *
 * Feature: media-engine-lag — Task 5.3 (Property 18)
 * Validates: Requirements 2.4, 5.8, 5.12
 *
 * What is under test
 * ------------------
 * The REAL keyed media-card adapter, `KeyedMediaCardHelper`
 * (js/core/keyedMediaCardHelper.js), driving the REAL shared single-card markup
 * (`renderTemplateCardMarkup` in js/templates/templates.js) against a REAL
 * parsed DOM tree. When background work produces a new thumbnail value, the
 * helper must patch exactly one `.thumb-img` inside the single card whose PARSED
 * DOM id equals `tpl-` + the Stable_Media_ID and leave every other DOM node
 * byte-identical (Req 2.4, 5.8). When it cannot locate exactly one `.thumb-img`,
 * cannot find the card, finds a duplicate identity, finds the node detached, or
 * cannot apply the requested patch, it must leave the DOM completely unchanged,
 * report exactly one failed card update, and never fall back to the full-grid
 * renderer (Req 5.12).
 *
 * How the DOM is provided
 * -----------------------
 * Jest runs with `testEnvironment: "node"` and the project pins its
 * dependencies (jest 29.7.0, fast-check 3.22.0) with no browser DOM package, so
 * the tree is built by tests/helpers/miniDom.js: a real HTML tokenizer + tree
 * builder with browser attribute-entity decoding. Markup is therefore produced
 * as a string, PARSED, attached, queried through `querySelectorAll`, and
 * mutated through `get/set/removeAttribute` — the same surface the panel uses.
 * No mocks of the helper, no in-memory index stand-in, no filesystem.
 *
 * Byte-identity check
 * -------------------
 * Every node reachable from the document element (plus a detached card when the
 * scenario detaches one) is serialized in document order as its tag name and
 * its full, sorted attribute set (text nodes as their data). Comparing the
 * before/after lists proves both that no node was added, removed, or reordered
 * and exactly which nodes' bytes changed.
 *
 * The file also retains the earlier focused `LibraryIndex.patchEntry`
 * regressions for save-import-performance-redesign Property 14 (Req 4.5, 4.6,
 * 12.7), which cover the in-memory index projection of the same idea.
 */

"use strict";

const path = require("path");
const fc = require("fast-check");
const { LibraryIndex } = require("../js/core/persistence.js");
const { KeyedMediaCardHelper } = require("../js/core/keyedMediaCardHelper.js");
const { loadHelpers } = require("./helpers/loadHelpers.js");
const { createMiniDocument, MiniElement } = require("./helpers/miniDom.js");

// ─── Load the real browser-side card markup (no module system) ───────────────
const p18Constants = loadHelpers({ file: path.join("js", "core", "constants.js") });
const p18Utils = loadHelpers({
    file: path.join("js", "core", "utils.js"),
    injected: {
        SECTIONS: p18Constants.get("SECTIONS"),
        IMAGE_SECTIONS: p18Constants.get("IMAGE_SECTIONS"),
    },
});
const p18Templates = loadHelpers({
    file: path.join("js", "templates", "templates.js"),
    injected: {
        SECTIONS: p18Constants.get("SECTIONS"),
        IMAGE_SECTIONS: p18Constants.get("IMAGE_SECTIONS"),
        escapeAttr: p18Utils.get("escapeAttr"),
        escapeHTML: p18Utils.get("escapeHTML"),
        nfs: function () { return { existsSync: function () { return false; } }; },
        allTemplates: [],
        showToast: function () { },
        rootPath: "",
    },
});

const renderTemplateCardMarkup = p18Templates.get("renderTemplateCardMarkup");
if (typeof renderTemplateCardMarkup !== "function") {
    throw new Error("Property 18 requires renderTemplateCardMarkup from js/templates/templates.js");
}

// ─── DOM snapshot / byte-identity helpers ────────────────────────────────────

// One node's own bytes: tag plus its complete, order-independent attribute set.
function serializeNode(node) {
    if (node.nodeType === 3) return "#text:" + node.data;
    const names = Object.keys(node._attributes).sort();
    const parts = [];
    for (let i = 0; i < names.length; i++) {
        parts.push(names[i] + '="' + node._attributes[names[i]] + '"');
    }
    return "<" + node.localName + (parts.length ? " " + parts.join(" ") : "") + ">";
}

function walk(node, out) {
    out.push({ node: node, serial: serializeNode(node) });
    const children = node.childNodes || [];
    for (let i = 0; i < children.length; i++) walk(children[i], out);
    return out;
}

function snapshotTrees(roots) {
    const out = [];
    for (let i = 0; i < roots.length; i++) if (roots[i]) walk(roots[i], out);
    return out;
}

// Returns the nodes whose bytes differ, and throws when the tree SHAPE changed
// (a different node count or a different node at some position).
function diffSnapshots(before, after) {
    expect(after.length).toBe(before.length);
    const changed = [];
    for (let i = 0; i < before.length; i++) {
        expect(after[i].node).toBe(before[i].node);
        if (after[i].serial !== before[i].serial) changed.push(after[i].node);
    }
    return changed;
}

// Count full-grid replacements (`grid.innerHTML = ...`), the renderer path the
// keyed helper must never take.
function watchFullGridReplacement(element) {
    const descriptor = Object.getOwnPropertyDescriptor(MiniElement.prototype, "innerHTML");
    const state = { assignments: 0 };
    Object.defineProperty(element, "innerHTML", {
        configurable: true,
        get: function () { return descriptor.get.call(element); },
        set: function (value) { state.assignments++; descriptor.set.call(element, value); },
    });
    return state;
}

// ─── Generators ──────────────────────────────────────────────────────────────

// Fragments hostile to attribute serialization, so the parsed `tpl-<id>`
// identity the patch targets is never a trivially safe string.
const p18HostileArb = fc.constantFrom(
    "\"", "'", "&", "<", ">", "&amp;", "&#39;", "a\"b'c", "<img src=x>", "100%", "café", "😀", "tpl-"
);

const p18ItemArb = fc.record({
    token: fc.stringMatching(/^[A-Za-z0-9]{1,6}$/),
    hostile: p18HostileArb,
    // Duplicate display names are intentional: identity comes from the ID only.
    name: fc.constantFrom("clip", "take", "shot", "b-roll"),
    category: fc.constantFrom("video", "image", "audio"),
    mediaType: fc.constantFrom("video", "image"),
});

// Each ID embeds its batch position, so a batch never repeats an identity.
function buildEntry(plan, position) {
    return {
        id: "media-" + position + "-" + plan.token + plan.hostile,
        name: plan.name,
        displayName: plan.name,
        category: plan.category,
        type: "media",
        mediaType: plan.mediaType,
        folderPath: "C:/media/p18/lib" + position,
        mediaFile: plan.name + position + ".mov",
        sourcePath: "C:/media/p18/src/" + plan.name + position + ".mov",
        thumbStatus: "placeholder",
        _isPending: true,
    };
}

// An approved patch that always carries a new thumbnail value (Req 5.8) and so
// always mutates both the card and its one `.thumb-img`.
const p18PatchArb = fc.record({
    thumbKey: fc.constantFrom("thumbnail", "thumbnailPath"),
    thumbToken: fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/),
    thumbStatus: fc.constantFrom(null, "ready", "failed", "rendering"),
    pending: fc.constantFrom(null, true, false),
    mediaKey: fc.constantFrom(null, "mediaPath", "mediaFile", "proxyFile"),
    terminalState: fc.constantFrom(null, "ready", "failed", "pending"),
    derivativeStatus: fc.constantFrom(null, "available", "unavailable"),
});

function buildPatch(plan, position) {
    const patch = {};
    patch[plan.thumbKey] = "C:/media/p18/thumbs/" + plan.thumbToken + position + ".png";
    if (plan.thumbStatus !== null) patch.thumbStatus = plan.thumbStatus;
    if (plan.pending !== null) patch._isPending = plan.pending;
    if (plan.mediaKey !== null) patch[plan.mediaKey] = "C:/media/p18/derived/" + plan.thumbToken + position + ".mp4";
    if (plan.terminalState !== null) patch.terminalState = plan.terminalState;
    if (plan.derivativeStatus !== null) patch.derivativeStatus = plan.derivativeStatus;
    return patch;
}

// "patch" appears twice so roughly a quarter of the runs exercise the success
// path and the rest spread over every documented failure condition.
const p18ScenarioArb = fc.record({
    kind: fc.constantFrom(
        "patch", "patch", "miss", "duplicate-id", "detached", "zero-thumb", "multi-thumb", "failed-application"
    ),
    via: fc.constantFrom("registry", "document"),
    patch: p18PatchArb,
});

const P18_EXPECTED_REASON = {
    miss: "missing-registration",
    detached: "detached-card",
    "zero-thumb": "thumbnail-count",
    "multi-thumb": "thumbnail-count",
    "failed-application": "patch-application-failed",
};

// A panel-like document: unrelated header/footer content, one live grid, and a
// decoy card that is parsed from the same markup but never registered.
function buildPanel(entries) {
    const document = createMiniDocument();

    const header = document.createElement("div");
    header.className = "panel-header";
    header.innerHTML = '<span class="title">Media</span><span class="count">0</span>';
    document.body.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "card-grid";
    document.body.appendChild(grid);

    const footer = document.createElement("div");
    footer.className = "panel-footer";
    footer.innerHTML = renderTemplateCardMarkup(
        {
            id: "decoy",
            name: "decoy",
            category: "video",
            type: "media",
            mediaType: "video",
            folderPath: "C:/media/p18/decoy",
            mediaFile: "decoy.mov",
            thumbnail: "C:/media/p18/decoy/decoy.png",
        },
        "media",
        []
    );
    document.body.appendChild(footer);

    const gridWatch = watchFullGridReplacement(grid);
    const failures = [];
    const patches = [];
    const rendererCalls = [];

    // The full-grid renderer the keyed path must never reach.
    p18Templates.context.renderCards = function () { rendererCalls.push("renderCards"); };
    p18Templates.context.renderIcons = function () { rendererCalls.push("renderIcons"); };
    p18Templates.context.filterAndRender = function () { rendererCalls.push("filterAndRender"); };

    const options = {
        document: document,
        renderCardMarkup: renderTemplateCardMarkup,
        metrics: { recordCardPatch: function (ok) { patches.push(!!ok); } },
        onFailedUpdate: function (reason) { failures.push(reason); },
    };

    const cards = new KeyedMediaCardHelper(options);
    const inserted = cards.insertBatch(entries, grid);

    return {
        document: document,
        grid: grid,
        gridWatch: gridWatch,
        cards: cards,
        options: options,
        inserted: inserted,
        failures: failures,
        patches: patches,
        rendererCalls: rendererCalls,
    };
}

// ─── Property 18 ─────────────────────────────────────────────────────────────
// Feature: media-engine-lag, Property 18: Keyed card operations are local and atomic
// **Validates: Requirements 2.4, 5.8, 5.12**
describe("Property 18: Keyed card operations are local and atomic (Req 2.4, 5.8, 5.12)", () => {
    test("a keyed patch mutates only the addressed card and its single .thumb-img; a miss, duplicate identity, detached node, wrong .thumb-img count, or failed application leaves the DOM byte-identical, reports one failed update, and never calls the full-grid renderer", () => {
        fc.assert(
            fc.property(
                fc.array(p18ItemArb, { minLength: 1, maxLength: 4 }),
                fc.nat(),
                p18ScenarioArb,
                (itemPlans, targetSel, scenario) => {
                    const entries = itemPlans.map(buildEntry);
                    const panel = buildPanel(entries);

                    // Insertion itself is keyed and additive.
                    expect(panel.inserted.ok).toBe(true);
                    expect(panel.inserted.ids).toEqual(entries.map(function (e) { return e.id; }));
                    expect(panel.gridWatch.assignments).toBe(0);

                    const position = targetSel % entries.length;
                    const targetId = entries[position].id;
                    const expectedDomId = "tpl-" + targetId;
                    const targetCard = panel.inserted.cards[position];

                    // The card the patch will address is exactly the one whose
                    // PARSED DOM id is `tpl-` + the Stable_Media_ID.
                    expect(targetCard.id).toBe(expectedDomId);
                    expect(panel.document.getElementById(expectedDomId)).toBe(targetCard);
                    expect(panel.document.querySelectorAll("#" + expectedDomId).length).toBe(1);
                    expect(targetCard.querySelectorAll(".thumb-img").length).toBe(1);

                    const patch = buildPatch(scenario.patch, position);
                    const roots = [panel.document.documentElement];
                    let acting = panel.cards;
                    let detachedCard = null;

                    // ── Set up the scenario's precondition ───────────────────
                    if (scenario.kind === "detached") {
                        panel.grid.removeChild(targetCard);
                        detachedCard = targetCard;
                        roots.push(targetCard);
                    } else if (scenario.kind === "zero-thumb") {
                        const image = targetCard.querySelector(".thumb-img");
                        image.parentNode.removeChild(image);
                    } else if (scenario.kind === "multi-thumb") {
                        const extra = panel.document.createElement("img");
                        extra.className = "thumb-img";
                        targetCard.querySelector(".thumb-box").appendChild(extra);
                    } else if (scenario.kind === "failed-application") {
                        // A DOM that refuses the thumbnail mutation.
                        targetCard.querySelector(".thumb-img").setAttribute = function () {
                            throw new Error("attribute rejected by the DOM");
                        };
                    } else if (scenario.kind === "duplicate-id" && scenario.via === "document") {
                        // A second helper sees the identity already in the DOM.
                        acting = new KeyedMediaCardHelper(panel.options);
                    }

                    // Baseline is taken AFTER the precondition, so any change
                    // observed below was made by the helper alone.
                    const before = snapshotTrees(roots);
                    const failuresBefore = panel.failures.length;
                    const patchesBefore = panel.patches.length;

                    // ── Act ─────────────────────────────────────────────────
                    let result;
                    if (scenario.kind === "miss") {
                        result = acting.patchById(targetId + "-not-registered", patch);
                    } else if (scenario.kind === "duplicate-id") {
                        result = acting.insertBatch([entries[position]], panel.grid);
                    } else {
                        result = acting.patchById(targetId, patch);
                    }

                    const after = snapshotTrees(roots);
                    const changed = diffSnapshots(before, after);

                    // ── The full-grid renderer is never invoked ─────────────
                    expect(panel.rendererCalls).toEqual([]);
                    expect(panel.gridWatch.assignments).toBe(0);

                    if (scenario.kind === "patch") {
                        expect(result.ok).toBe(true);
                        expect(result.id).toBe(targetId);
                        expect(result.card).toBe(targetCard);
                        expect(result.card.id).toBe(expectedDomId);

                        // Exactly one `.thumb-img` descendant was the target.
                        const thumbs = targetCard.querySelectorAll(".thumb-img");
                        expect(thumbs.length).toBe(1);
                        expect(result.image).toBe(thumbs[0]);
                        expect(targetCard.contains(result.image)).toBe(true);

                        // The new thumbnail value reached that one element.
                        const src = result.image.getAttribute("src");
                        expect(typeof src).toBe("string");
                        expect(src.length).toBeGreaterThan(0);
                        expect(targetCard.getAttribute("data-thumb")).toBe(src);

                        // Only the addressed card and its one image differ; the
                        // header, footer decoy, grid, sibling cards, and every
                        // other node are byte-identical.
                        expect(changed.indexOf(targetCard)).toBeGreaterThan(-1);
                        expect(changed.indexOf(result.image)).toBeGreaterThan(-1);
                        for (let i = 0; i < changed.length; i++) {
                            expect(changed[i] === targetCard || changed[i] === result.image).toBe(true);
                        }
                        // Sibling cards keep their placeholder bytes exactly.
                        for (let i = 0; i < panel.inserted.cards.length; i++) {
                            if (i === position) continue;
                            expect(changed.indexOf(panel.inserted.cards[i])).toBe(-1);
                            expect(panel.inserted.cards[i].getAttribute("data-thumb")).toBe("");
                            expect(panel.inserted.cards[i].querySelectorAll(".thumb-img").length).toBe(1);
                            expect(panel.inserted.cards[i].querySelector(".thumb-img").hasAttribute("src")).toBe(false);
                        }

                        // Exactly one successful update, none failed.
                        expect(panel.patches.slice(patchesBefore)).toEqual([true]);
                        expect(panel.failures.length).toBe(failuresBefore);
                    } else {
                        expect(result.ok).toBe(false);
                        const expectedReason = scenario.kind === "duplicate-id"
                            ? (scenario.via === "document" ? "duplicate-card" : "duplicate-registration")
                            : P18_EXPECTED_REASON[scenario.kind];
                        expect(result.reason).toBe(expectedReason);

                        // The DOM is completely unchanged — including the node
                        // the helper had already started to touch before the
                        // application failed (rolled back).
                        expect(changed).toEqual([]);

                        // Exactly one failed card update is reported.
                        expect(panel.failures.slice(failuresBefore)).toEqual([expectedReason]);
                        expect(panel.patches.slice(patchesBefore)).toEqual([false]);

                        if (detachedCard) {
                            // The detached node was not adopted or mutated.
                            expect(detachedCard.parentNode).toBe(null);
                            expect(panel.document.getElementById(expectedDomId)).toBe(null);
                        }
                    }

                    panel.cards.dispose();
                }
            ),
            { numRuns: 120 }
        );
    });
});

// ─── Retained regressions: the in-memory index projection ────────────────────
// save-import-performance-redesign Property 14 examples (Req 4.5, 4.6, 12.7):
// a completed or failed job patches exactly one LibraryIndex entry and never
// raises the full-scan flag.
describe("A completed or failed job patches exactly one index entry without a scan (Req 4.5, 4.6, 12.7)", () => {
    test("thumbnail completion swaps only the target card to a ready state", () => {
        const index = new LibraryIndex();
        index.insertAtHead({ folderPath: "root/a", id: "a", thumbStatus: "placeholder" });
        index.insertAtHead({ folderPath: "root/b", id: "b", thumbStatus: "placeholder" });

        const ok = index.patchEntry("root/a", { thumbStatus: "ready", thumbnailPath: "t/a.png" });

        expect(ok).toBe(true);
        expect(index.needsFullScan()).toBe(false);
        expect(index.getEntry("root/a").thumbStatus).toBe("ready");
        expect(index.getEntry("root/a").thumbnailPath).toBe("t/a.png");
        // The untouched card keeps its placeholder state.
        expect(index.getEntry("root/b").thumbStatus).toBe("placeholder");
        expect(index.getEntry("root/b").thumbnailPath).toBeUndefined();
    });

    test("job failure marks only the target card failed without touching neighbours", () => {
        const index = new LibraryIndex();
        index.insertAtHead({ folderPath: "root/a", id: "a", thumbStatus: "placeholder" });
        index.insertAtHead({ folderPath: "root/b", id: "b", thumbStatus: "ready", thumbnailPath: "t/b.png" });

        const ok = index.patchEntry("root/a", { thumbStatus: "failed" });

        expect(ok).toBe(true);
        expect(index.needsFullScan()).toBe(false);
        expect(index.getEntry("root/a").thumbStatus).toBe("failed");
        // The neighbour's ready thumbnail is untouched.
        expect(index.getEntry("root/b")).toEqual({
            folderPath: "root/b",
            id: "b",
            thumbStatus: "ready",
            thumbnailPath: "t/b.png",
        });
    });
});
