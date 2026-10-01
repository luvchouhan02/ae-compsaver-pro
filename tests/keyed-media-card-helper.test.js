/**
 * Keyed media-card helper — focused examples
 * ==========================================
 *
 * Feature: media-engine-lag — Task 5.4
 * Validates: Requirements 5.7, 5.8, 5.12, 7.11
 *
 * What is under test
 * ------------------
 * The REAL keyed media-card adapter, `KeyedMediaCardHelper`
 * (js/core/keyedMediaCardHelper.js), together with the REAL shared single-card
 * markup (`renderTemplateCardMarkup` / `escapeTemplateCardAttribute` in
 * js/templates/templates.js), against a REAL parsed DOM tree.
 *
 * These are concrete examples, not properties. The generated coverage lives in
 * tests/media-index-migration.property.test.js (Property 17) and
 * tests/single-card-patch-job-completion.property.test.js (Property 18); this
 * file pins the specific hostile values a reviewer wants to see named:
 *
 *   - Stable_Media_IDs containing `"`, `'`, `&`, `<`, `>`, entity-looking text,
 *     and Unicode / emoji: the escaped attribute parses back to exactly
 *     `tpl-` + the ID (Req 5.7).
 *   - Legacy-style `legacy-<encoded path>` identifiers (Req 5.7).
 *   - Two entries with the same display name but distinct IDs: each gets its own
 *     card and patches independently (Req 7.11, 5.8).
 *   - Zero and multiple `.thumb-img` targets: the DOM is left unchanged, exactly
 *     one failed card update is reported, and the full-grid renderer is never
 *     called (Req 5.12).
 *
 * How the DOM is provided
 * -----------------------
 * Jest runs with `testEnvironment: "node"` and the project pins its dependencies
 * (jest 29.7.0, fast-check 3.22.0) with no browser DOM package, so the tree is
 * built by tests/helpers/miniDom.js: a real HTML tokenizer + tree builder with
 * browser attribute-entity decoding. Markup is produced as a string, PARSED,
 * attached, queried through `querySelectorAll`, and mutated through
 * `get/set/removeAttribute` — the same surface the panel uses. No mocks of the
 * helper, no in-memory index stand-in, no filesystem.
 */

"use strict";

const path = require("path");
const { KeyedMediaCardHelper } = require("../js/core/keyedMediaCardHelper.js");
const { loadHelpers } = require("./helpers/loadHelpers.js");
const { createMiniDocument, parseSingleElement, decodeEntities, MiniElement } = require("./helpers/miniDom.js");

// ─── Load the real browser-side card markup (no module system) ───────────────
const constants = loadHelpers({ file: path.join("js", "core", "constants.js") });
const utils = loadHelpers({
    file: path.join("js", "core", "utils.js"),
    injected: {
        SECTIONS: constants.get("SECTIONS"),
        IMAGE_SECTIONS: constants.get("IMAGE_SECTIONS"),
    },
});
const templates = loadHelpers({
    file: path.join("js", "templates", "templates.js"),
    injected: {
        SECTIONS: constants.get("SECTIONS"),
        IMAGE_SECTIONS: constants.get("IMAGE_SECTIONS"),
        escapeAttr: utils.get("escapeAttr"),
        escapeHTML: utils.get("escapeHTML"),
        nfs: function () { return { existsSync: function () { return false; } }; },
        allTemplates: [],
        showToast: function () { },
        rootPath: "",
    },
});

const renderTemplateCardMarkup = templates.get("renderTemplateCardMarkup");
const escapeTemplateCardAttribute = templates.get("escapeTemplateCardAttribute");
if (typeof renderTemplateCardMarkup !== "function" || typeof escapeTemplateCardAttribute !== "function") {
    throw new Error("Task 5.4 requires the shared card markup helpers from js/templates/templates.js");
}

// ─── DOM snapshot helpers (byte identity, document order) ────────────────────

function serializeNode(node) {
    if (node.nodeType === 3) return "#text:" + node.data;
    const names = Object.keys(node._attributes).sort();
    const parts = [];
    for (let i = 0; i < names.length; i++) parts.push(names[i] + '="' + node._attributes[names[i]] + '"');
    return "<" + node.localName + (parts.length ? " " + parts.join(" ") : "") + ">";
}

function walk(node, out) {
    out.push({ node: node, serial: serializeNode(node) });
    const children = node.childNodes || [];
    for (let i = 0; i < children.length; i++) walk(children[i], out);
    return out;
}

function snapshotTree(root) {
    return walk(root, []);
}

// Nodes whose bytes differ. Throws when the tree SHAPE changed.
function diffSnapshots(before, after) {
    expect(after.length).toBe(before.length);
    const changed = [];
    for (let i = 0; i < before.length; i++) {
        expect(after[i].node).toBe(before[i].node);
        if (after[i].serial !== before[i].serial) changed.push(after[i].node);
    }
    return changed;
}

// Count full-grid replacements (`grid.innerHTML = ...`) — the renderer path the
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

// ─── Panel fixture ───────────────────────────────────────────────────────────

function mediaEntry(overrides) {
    const entry = {
        id: "media-1",
        name: "clip",
        displayName: "clip",
        category: "video",
        type: "media",
        mediaType: "video",
        folderPath: "C:/media/lib",
        mediaFile: "clip.mov",
        sourcePath: "C:/media/src/clip.mov",
        thumbStatus: "placeholder",
        _isPending: true,
    };
    const keys = Object.keys(overrides || {});
    for (let i = 0; i < keys.length; i++) entry[keys[i]] = overrides[keys[i]];
    return entry;
}

function buildPanel() {
    const document = createMiniDocument();

    const header = document.createElement("div");
    header.className = "panel-header";
    header.innerHTML = '<span class="title">Media</span><span class="count">0</span>';
    document.body.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "card-grid";
    document.body.appendChild(grid);

    const gridWatch = watchFullGridReplacement(grid);
    const failures = [];
    const patches = [];
    const rendererCalls = [];

    templates.context.renderCards = function () { rendererCalls.push("renderCards"); };
    templates.context.renderIcons = function () { rendererCalls.push("renderIcons"); };
    templates.context.filterAndRender = function () { rendererCalls.push("filterAndRender"); };

    const cards = new KeyedMediaCardHelper({
        document: document,
        renderCardMarkup: renderTemplateCardMarkup,
        metrics: { recordCardPatch: function (ok) { patches.push(!!ok); } },
        onFailedUpdate: function (reason) { failures.push(reason); },
    });

    return {
        document: document,
        grid: grid,
        gridWatch: gridWatch,
        cards: cards,
        failures: failures,
        patches: patches,
        rendererCalls: rendererCalls,
    };
}

// ─── Req 5.7: hostile Stable_Media_IDs survive escape → parse ────────────────

const HOSTILE_IDS = [
    ['double quotes', 'media-"quoted"-1'],
    ['single quotes', "media-'quoted'-2"],
    ["ampersand", "media-a&b-3"],
    ["angle brackets", "media-<b>bold</b>-4"],
    ["an injected tag", 'media-<img src=x onerror="boom()">-5'],
    ["entity-looking text", "media-&amp;-6"],
    ["a numeric entity", "media-&#39;-7"],
    ["a hex entity", "media-&#x27;-8"],
    ["every hostile character at once", "media-\"'&<>-9"],
    ["accented Unicode", "media-café-Ünïcödé-10"],
    ["CJK text", "media-素材-11"],
    ["emoji", "media-😀🎬-12"],
    ["a tpl- prefix inside the id", "media-tpl-tpl-13"],
    ["legacy encoded path", "legacy-" + encodeURIComponent("C:/media/My Clip&More \"v2\".mov")],
    ["legacy path with raw hostile characters", "legacy-C:/media/A&B <v2>/clip'1\".mov"],
];

describe("Stable_Media_ID escaping survives markup and parsing (Req 5.7)", () => {
    HOSTILE_IDS.forEach(([label, id]) => {
        test("an id with " + label + " parses back to exactly tpl- + the id", () => {
            const expectedDomId = "tpl-" + id;
            const escaped = escapeTemplateCardAttribute(expectedDomId);

            // The escaped value can never terminate the double-quoted attribute
            // or open a tag.
            expect(escaped.indexOf('"')).toBe(-1);
            expect(escaped.indexOf("<")).toBe(-1);
            expect(escaped.indexOf(">")).toBe(-1);
            // ...and decodes back to the exact identifier.
            expect(decodeEntities(escaped)).toBe(expectedDomId);

            const markup = renderTemplateCardMarkup(mediaEntry({ id: id }), "media", []);
            expect(markup.indexOf(' id="' + escaped + '"')).toBeGreaterThan(-1);

            // Parsed identity, not just string identity.
            const parsed = parseSingleElement(markup);
            expect(parsed.id).toBe(expectedDomId);
            expect(parsed.querySelectorAll(".thumb-img").length).toBe(1);
        });

        test("the real helper inserts and patches the card addressed by an id with " + label, () => {
            const panel = buildPanel();
            const entry = mediaEntry({ id: id });
            const expectedDomId = "tpl-" + id;

            const inserted = panel.cards.insertBatch([entry], panel.grid);
            expect(inserted.ok).toBe(true);
            expect(inserted.ids).toEqual([id]);

            const card = inserted.cards[0];
            expect(card.id).toBe(expectedDomId);
            expect(panel.document.getElementById(expectedDomId)).toBe(card);
            expect(panel.document.querySelectorAll("#" + expectedDomId).length).toBe(1);

            const result = panel.cards.patchById(id, {
                thumbnail: "C:/media/lib/thumbs/clip.png",
                thumbStatus: "ready",
                _isPending: false,
            });

            expect(result.ok).toBe(true);
            expect(result.card).toBe(card);
            expect(card.querySelectorAll(".thumb-img").length).toBe(1);
            expect(result.image).toBe(card.querySelector(".thumb-img"));
            expect(result.image.getAttribute("src")).toBe(card.getAttribute("data-thumb"));
            expect(result.image.getAttribute("src")).toBe("file:///C:/media/lib/thumbs/clip.png");
            // Identity is untouched by the patch.
            expect(card.id).toBe(expectedDomId);
            expect(panel.failures).toEqual([]);
            expect(panel.patches).toEqual([true]);
            expect(panel.rendererCalls).toEqual([]);
            expect(panel.gridWatch.assignments).toBe(0);

            panel.cards.dispose();
        });
    });
});

// ─── Req 7.11 / 5.8: duplicate display names, distinct identities ────────────

describe("Duplicate display names keep independent cards (Req 7.11, 5.8)", () => {
    test("two entries with the same display name and distinct ids each get their own card and patch independently", () => {
        const panel = buildPanel();
        const first = mediaEntry({
            id: "media-dup-a",
            name: "clip",
            displayName: "clip",
            mediaFile: "clip.mov",
            sourcePath: "C:/media/src/one/clip.mov",
        });
        const second = mediaEntry({
            id: "media-dup-b",
            name: "clip",
            displayName: "clip",
            mediaFile: "clip.mov",
            sourcePath: "C:/media/src/two/clip.mov",
        });

        const inserted = panel.cards.insertBatch([first, second], panel.grid);
        expect(inserted.ok).toBe(true);
        expect(inserted.ids).toEqual(["media-dup-a", "media-dup-b"]);

        const cardA = inserted.cards[0];
        const cardB = inserted.cards[1];

        // Same visible name, two distinct DOM identities, two distinct cards.
        expect(cardA).not.toBe(cardB);
        expect(cardA.getAttribute("data-file")).toBe("clip");
        expect(cardB.getAttribute("data-file")).toBe("clip");
        expect(cardA.id).toBe("tpl-media-dup-a");
        expect(cardB.id).toBe("tpl-media-dup-b");
        expect(panel.document.getElementById("tpl-media-dup-a")).toBe(cardA);
        expect(panel.document.getElementById("tpl-media-dup-b")).toBe(cardB);
        expect(panel.grid.children.length).toBe(2);

        // Patch the first only.
        const before = snapshotTree(panel.document.documentElement);
        const patchedA = panel.cards.patchById("media-dup-a", {
            thumbnail: "C:/media/lib/thumbs/a.png",
            thumbStatus: "ready",
            _isPending: false,
        });
        const changedByA = diffSnapshots(before, snapshotTree(panel.document.documentElement));

        expect(patchedA.ok).toBe(true);
        expect(changedByA.length).toBe(2);
        expect(changedByA.indexOf(cardA)).toBeGreaterThan(-1);
        expect(changedByA.indexOf(patchedA.image)).toBeGreaterThan(-1);
        expect(cardA.contains(patchedA.image)).toBe(true);
        expect(cardB.contains(patchedA.image)).toBe(false);

        // The twin is still an untouched placeholder.
        expect(cardB.getAttribute("data-thumb")).toBe("");
        expect(cardB.querySelector(".thumb-img").hasAttribute("src")).toBe(false);
        expect(cardB.className.indexOf("media-pending")).toBeGreaterThan(-1);

        // Patch the second: it lands on its own card, and the first keeps its value.
        const patchedB = panel.cards.patchById("media-dup-b", {
            thumbnailPath: "C:/media/lib/thumbs/b.png",
            thumbStatus: "failed",
        });

        expect(patchedB.ok).toBe(true);
        expect(patchedB.card).toBe(cardB);
        expect(patchedB.image).not.toBe(patchedA.image);
        expect(cardA.getAttribute("data-thumb")).toBe("file:///C:/media/lib/thumbs/a.png");
        expect(cardB.getAttribute("data-thumb")).toBe("file:///C:/media/lib/thumbs/b.png");
        expect(cardA.getAttribute("data-thumbstatus")).toBe("ready");
        expect(cardB.getAttribute("data-thumbstatus")).toBe("failed");
        expect(cardA.className.indexOf("thumb-failed")).toBe(-1);
        expect(cardB.className.indexOf("thumb-failed")).toBeGreaterThan(-1);

        expect(panel.patches).toEqual([true, true]);
        expect(panel.failures).toEqual([]);
        expect(panel.rendererCalls).toEqual([]);
        expect(panel.gridWatch.assignments).toBe(0);

        panel.cards.dispose();
    });

    test("two source files sharing a display name are registered under their own stable ids", () => {
        const panel = buildPanel();
        const inserted = panel.cards.insertBatch(
            [
                mediaEntry({ id: "same-name-1", name: "b-roll", displayName: "b-roll", sourcePath: "C:/a/b-roll.mov" }),
                mediaEntry({ id: "same-name-2", name: "b-roll", displayName: "b-roll", sourcePath: "C:/b/b-roll.mov" }),
            ],
            panel.grid
        );

        expect(inserted.ok).toBe(true);
        expect(panel.document.querySelectorAll(".card").length).toBe(2);
        // A miss on one identity never resolves to the same-named sibling.
        const miss = panel.cards.patchById("same-name-3", { thumbStatus: "ready" });
        expect(miss.ok).toBe(false);
        expect(miss.reason).toBe("missing-registration");
        expect(panel.failures).toEqual(["missing-registration"]);
        expect(panel.rendererCalls).toEqual([]);

        panel.cards.dispose();
    });
});

// ─── Req 5.12: zero and multiple `.thumb-img` targets ────────────────────────

describe("A wrong .thumb-img count leaves the DOM unchanged (Req 5.12)", () => {
    function setupTwoCards() {
        const panel = buildPanel();
        const inserted = panel.cards.insertBatch(
            [mediaEntry({ id: "target" }), mediaEntry({ id: "neighbour", name: "take", mediaFile: "take.mov" })],
            panel.grid
        );
        expect(inserted.ok).toBe(true);
        return { panel: panel, target: inserted.cards[0], neighbour: inserted.cards[1] };
    }

    test("zero .thumb-img targets: no mutation, exactly one failed update, no full-grid render", () => {
        const fixture = setupTwoCards();
        const panel = fixture.panel;

        // Remove the only patch target.
        const image = fixture.target.querySelector(".thumb-img");
        image.parentNode.removeChild(image);
        expect(fixture.target.querySelectorAll(".thumb-img").length).toBe(0);

        const before = snapshotTree(panel.document.documentElement);
        const result = panel.cards.patchById("target", {
            thumbnail: "C:/media/lib/thumbs/target.png",
            thumbStatus: "ready",
            _isPending: false,
        });
        const changed = diffSnapshots(before, snapshotTree(panel.document.documentElement));

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("thumbnail-count");
        expect(changed).toEqual([]);
        expect(fixture.target.getAttribute("data-thumb")).toBe("");
        expect(fixture.target.hasAttribute("data-thumbstatus")).toBe(false);
        expect(fixture.neighbour.getAttribute("data-thumb")).toBe("");
        expect(panel.failures).toEqual(["thumbnail-count"]);
        expect(panel.patches).toEqual([false]);
        expect(panel.rendererCalls).toEqual([]);
        expect(panel.gridWatch.assignments).toBe(0);

        panel.cards.dispose();
    });

    test("multiple .thumb-img targets: no mutation, exactly one failed update, no full-grid render", () => {
        const fixture = setupTwoCards();
        const panel = fixture.panel;

        // A second, ambiguous patch target inside the same card.
        const extra = panel.document.createElement("img");
        extra.className = "thumb-img";
        fixture.target.querySelector(".thumb-box").appendChild(extra);
        expect(fixture.target.querySelectorAll(".thumb-img").length).toBe(2);

        const before = snapshotTree(panel.document.documentElement);
        const result = panel.cards.patchById("target", {
            thumbnailPath: "C:/media/lib/thumbs/target.png",
            terminalState: "ready",
        });
        const changed = diffSnapshots(before, snapshotTree(panel.document.documentElement));

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("thumbnail-count");
        expect(changed).toEqual([]);
        const thumbs = fixture.target.querySelectorAll(".thumb-img");
        expect(thumbs.length).toBe(2);
        expect(thumbs[0].hasAttribute("src")).toBe(false);
        expect(thumbs[1].hasAttribute("src")).toBe(false);
        expect(fixture.target.hasAttribute("data-terminalstate")).toBe(false);
        expect(panel.failures).toEqual(["thumbnail-count"]);
        expect(panel.patches).toEqual([false]);
        expect(panel.rendererCalls).toEqual([]);
        expect(panel.gridWatch.assignments).toBe(0);

        panel.cards.dispose();
    });

    test("a card whose markup carries a duplicate .thumb-img is never inserted", () => {
        const panel = buildPanel();
        const doubled = function (entry, section, selectedKeys) {
            const markup = renderTemplateCardMarkup(entry, section, selectedKeys);
            return markup.replace('<div class="thumb-box">', '<div class="thumb-box"><img class="thumb-img" alt="">');
        };
        const cards = new KeyedMediaCardHelper({
            document: panel.document,
            renderCardMarkup: doubled,
            metrics: { recordCardPatch: function (ok) { panel.patches.push(!!ok); } },
            onFailedUpdate: function (reason) { panel.failures.push(reason); },
        });

        const before = snapshotTree(panel.document.documentElement);
        const result = cards.insertBatch([mediaEntry({ id: "ambiguous" })], panel.grid);
        const changed = diffSnapshots(before, snapshotTree(panel.document.documentElement));

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("thumbnail-count");
        expect(changed).toEqual([]);
        expect(panel.grid.children.length).toBe(0);
        expect(panel.document.getElementById("tpl-ambiguous")).toBe(null);
        expect(panel.failures).toEqual(["thumbnail-count"]);
        expect(panel.patches).toEqual([false]);
        expect(panel.rendererCalls).toEqual([]);
        expect(panel.gridWatch.assignments).toBe(0);

        cards.dispose();
        panel.cards.dispose();
    });
});
