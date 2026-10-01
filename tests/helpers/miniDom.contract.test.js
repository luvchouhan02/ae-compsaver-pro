// ============================================================
// tests/helpers/miniDom.contract.test.js
//
// catalog-patch-ordering-fixes — Task 2, P13/P14 preservation baseline
//
// This file records the shared helper's UNFIXED behavior before BUG D extends
// it. It intentionally does not ask for selector lists, dataset, classList,
// style, or a textContent setter; Task 3 owns those additions and will compare
// the extended helper against these same observations.
// ============================================================

"use strict";

const fs = require("fs");
const path = require("path");
const fc = require("fast-check");

const { loadHelpers, REPO_ROOT } = require("./loadHelpers.js");
const {
    createMiniDocument,
    parseSingleElement,
    MiniElement,
} = require("./miniDom.js");

const constants = loadHelpers({
    file: path.join("js", "core", "constants.js"),
    lenient: false,
});
const SECTIONS = constants.get("SECTIONS");
const IMAGE_SECTIONS = constants.get("IMAGE_SECTIONS");
const utils = loadHelpers({
    file: path.join("js", "core", "utils.js"),
    injected: { SECTIONS: SECTIONS, IMAGE_SECTIONS: IMAGE_SECTIONS },
    lenient: false,
});
const templates = loadHelpers({
    file: path.join("js", "templates", "templates.js"),
    injected: {
        SECTIONS: SECTIONS,
        IMAGE_SECTIONS: IMAGE_SECTIONS,
        escapeAttr: utils.get("escapeAttr"),
        escapeHTML: utils.get("escapeHTML"),
        nfs: function () { return { existsSync: function () { return false; } }; },
        allTemplates: [],
        showToast: function () { },
        rootPath: "",
    },
    lenient: false,
});
const escapeTemplateCardAttribute = templates.get("escapeTemplateCardAttribute");
if (typeof escapeTemplateCardAttribute !== "function") {
    throw new Error("P13 requires the real escapeTemplateCardAttribute helper");
}

const OBSERVED = [];
function observe(caseId, note, data) {
    for (let i = 0; i < OBSERVED.length; i++) {
        if (OBSERVED[i].caseId === caseId) return;
    }
    OBSERVED.push({ caseId: caseId, note: note, data: data });
}

afterAll(function () {
    if (!OBSERVED.length) return;
    const lines = ["", "═══ miniDom PRE-FIX CONTRACT OBSERVATIONS ═══"];
    OBSERVED.forEach(function (entry) {
        lines.push("", "[" + entry.caseId + "] " + entry.note, JSON.stringify(entry.data, null, 2));
    });
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
});

const TAGS = ["div", "span", "article", "strong", "em", "section"];
const CLASSES = ["card", "icon-card", "alpha", "beta", "gamma"];

function walkElements(root, out) {
    const children = root.childNodes || [];
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType !== 1) continue;
        out.push(child);
        walkElements(child, out);
    }
    return out;
}

function independentlyMatches(element, selector) {
    if (selector.charAt(0) === ".") {
        return element.className.split(/\s+/).filter(Boolean).indexOf(selector.substring(1)) !== -1;
    }
    if (selector.charAt(0) === "#") return element.id === selector.substring(1);
    return element.localName === selector.toLowerCase();
}

function buildGeneratedTree(spec) {
    const document = createMiniDocument();
    const holder = document.createElement("main");
    holder.id = "contract-holder";
    document.body.appendChild(holder);
    const nodes = [];

    spec.nodes.forEach(function (shape, index) {
        const node = document.createElement(TAGS[shape.tagIndex % TAGS.length]);
        node.id = "node-" + index + "-" + shape.idSuffix;
        const classNames = [];
        for (let bit = 0; bit < CLASSES.length; bit++) {
            if ((shape.classMask & (1 << bit)) !== 0) classNames.push(CLASSES[bit]);
        }
        node.className = classNames.join(" ");
        const parent = index === 0 ? holder : nodes[shape.parentIndex % index];
        parent.appendChild(node);
        nodes.push(node);
    });

    const target = nodes[spec.selectorIndex % nodes.length];
    let selector;
    if (spec.selectorKind === 0) selector = target.localName;
    else if (spec.selectorKind === 1) selector = "." + CLASSES[spec.selectorIndex % CLASSES.length];
    else selector = "#" + target.id;

    return { document: document, holder: holder, nodes: nodes, selector: selector };
}

const TREE_ARB = fc.record({
    nodes: fc.array(fc.record({
        parentIndex: fc.nat({ max: 50 }),
        tagIndex: fc.nat({ max: TAGS.length - 1 }),
        classMask: fc.nat({ max: (1 << CLASSES.length) - 1 }),
        idSuffix: fc.stringOf(fc.constantFrom("a", "b", "c", "1", "2", "-"), {
            minLength: 0,
            maxLength: 8,
        }),
    }), { minLength: 1, maxLength: 24 }),
    selectorKind: fc.nat({ max: 2 }),
    selectorIndex: fc.nat({ max: 100 }),
});

describe("P13 — miniDom's existing surface is recorded before extension (Property 8)", () => {
    test("300 generated trees preserve single-selector querySelector/querySelectorAll semantics", () => {
        // **Validates: Requirements 3.15**
        let firstObservation = null;
        fc.assert(
            fc.property(TREE_ARB, function (spec) {
                const world = buildGeneratedTree(spec);
                const holderWalk = walkElements(world.holder, []);
                const documentWalk = walkElements(world.document.documentElement, []);
                const expectedHolder = holderWalk.filter(function (node) {
                    return independentlyMatches(node, world.selector);
                });
                const expectedDocument = documentWalk.filter(function (node) {
                    return independentlyMatches(node, world.selector);
                });

                const holderAll = Array.prototype.slice.call(world.holder.querySelectorAll(world.selector));
                const documentAll = Array.prototype.slice.call(world.document.querySelectorAll(world.selector));
                expect(holderAll).toEqual(expectedHolder);
                expect(documentAll).toEqual(expectedDocument);
                expect(world.holder.querySelector(world.selector))
                    .toBe(expectedHolder.length ? expectedHolder[0] : null);
                expect(world.document.querySelector(world.selector))
                    .toBe(expectedDocument.length ? expectedDocument[0] : null);

                if (firstObservation === null) {
                    firstObservation = {
                        selector: world.selector,
                        nodeCount: world.nodes.length,
                        holderMatches: holderAll.map(function (node) { return node.id; }),
                        documentMatches: documentAll.map(function (node) { return node.id; }),
                    };
                }
            }),
            { numRuns: 300, seed: 20261011 }
        );
        observe("P13-selectors", "single-selector corpus (first of 300 generated trees)", firstObservation);
    });

    test("getElementById treats commas, entities, spaces, and # as id data", () => {
        // **Validates: Requirements 3.14, 3.15**
        const document = createMiniDocument();
        const ids = [
            "tpl-comma,id",
            "tpl-entity-&amp;-id",
            "tpl-space id",
            "tpl-hash#id",
            "tpl-all , &amp; # together",
        ];
        const elements = ids.map(function (id) {
            const element = document.createElement("div");
            element.id = id;
            document.body.appendChild(element);
            return element;
        });

        ids.forEach(function (id, index) {
            expect(document.getElementById(id)).toBe(elements[index]);
        });
        expect(document.getElementById("missing,id")).toBeNull();
        observe("P13-getElementById", "hostile ids resolved without selector-list splitting", { ids: ids });
    });

    test("1000 generated record ids survive real escapeTemplateCardAttribute then parse", () => {
        // **Validates: Requirements 3.14**
        const chars = [
            "a", "Z", "0", "-", "_", " ", ",", "#", "&", ";", "<", ">", "\"", "'",
            "é", "素", "😀",
        ];
        const idArbitrary = fc.array(fc.constantFrom.apply(fc, chars), { minLength: 0, maxLength: 45 })
            .map(function (parts) { return parts.join(""); });
        let first = null;

        fc.assert(
            fc.property(idArbitrary, function (recordId) {
                const expected = "tpl-" + recordId;
                const escaped = escapeTemplateCardAttribute(expected);
                const parsed = parseSingleElement('<div id="' + escaped + '"></div>');
                expect(parsed.id).toBe(expected);
                if (first === null) first = { recordId: recordId, escaped: escaped, parsedId: parsed.id };
            }),
            { numRuns: 1000, seed: 20261012 }
        );
        observe("P13-id-roundtrip", "first of 1000 generated escape → parse identities", first);
    });

    test("innerHTML get/set and the textContent getter keep their observed semantics", () => {
        // **Validates: Requirements 3.15**
        const document = createMiniDocument();
        const root = document.createElement("div");
        const firstMarkup = '<span>A&amp;B<strong>&lt;C&gt;</strong></span><em> D </em>';
        root.innerHTML = firstMarkup;

        expect(root.innerHTML).toBe(firstMarkup);
        expect(root.textContent).toBe("A&B<C> D ");
        const detached = root.childNodes.slice();

        const secondMarkup = '<article id="second"><span>next</span></article>';
        root.innerHTML = secondMarkup;
        expect(root.innerHTML).toBe(secondMarkup);
        expect(root.textContent).toBe("next");
        detached.forEach(function (node) { expect(node.parentNode).toBeNull(); });
        expect(root.querySelector("#second")).not.toBeNull();

        observe("P13-content", "cached innerHTML plus recursive textContent getter", {
            firstMarkup: firstMarkup,
            firstText: "A&B<C> D ",
            secondMarkup: secondMarkup,
            secondText: root.textContent,
        });
    });

    test("the observed HTML/SVG void-element set leaves following markup as siblings", () => {
        // **Validates: Requirements 3.15**
        const voidElements = [
            "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
            "param", "source", "track", "wbr", "circle", "ellipse", "line", "path", "polygon",
            "polyline", "rect", "stop", "use",
        ];

        voidElements.forEach(function (tag) {
            const root = parseSingleElement(
                '<div><' + tag + ' id="void"><span id="after">after</span></div>'
            );
            const voidNode = root.querySelector("#void");
            const after = root.querySelector("#after");
            expect(voidNode).not.toBeNull();
            expect(after).not.toBeNull();
            expect(after.parentNode).toBe(root);
            expect(voidNode.childNodes.length).toBe(0);
        });
        observe("P13-void", "void elements whose parser behavior is pinned", { tags: voidElements });
    });
});

function readRepoFile(relPath) {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("P14 — suites that extend miniDom retain their descriptor seams (Property 8)", () => {
    test("the three extending suites still contain their intended installs and none redefines textContent", () => {
        // **Validates: Requirements 3.16**
        const reconcile = readRepoFile(path.join("tests", "performance", "startup-reconcile.property.test.js"));
        const warm = readRepoFile(path.join("tests", "performance", "startup-warm-paint.property.test.js"));
        const lifecycle = readRepoFile(path.join("tests", "performance", "startup-lifecycle.property.test.js"));
        const combined = reconcile + "\n" + warm + "\n" + lifecycle;

        expect(reconcile).toContain('Object.defineProperty(MiniElement.prototype, "outerHTML"');
        expect(reconcile).toContain('Object.defineProperty(element, "innerHTML"');
        expect(warm).toContain("element.insertAdjacentHTML = function");
        expect(warm).toContain('Object.defineProperty(element, "innerHTML"');
        expect(lifecycle).toContain("Object.getOwnPropertyDescriptor(");
        expect(lifecycle).toContain('"innerHTML"');
        expect(/Object\.defineProperty\s*\(\s*MiniElement\.prototype\s*,\s*["']textContent["']/.test(combined))
            .toBe(false);

        observe("P14-source", "descriptor seams in the three unmodified consumer suites", {
            startupReconcile: ["prototype.outerHTML", "per-grid live innerHTML"],
            startupWarmPaint: ["per-grid innerHTML", "per-grid insertAdjacentHTML"],
            startupLifecycle: ["reuses the innerHTML descriptor", "per-grid insertAdjacentHTML"],
            redefinesTextContent: false,
        });
    });

    test("prototype and per-element extension points accept the same installs today", () => {
        // **Validates: Requirements 3.16**
        const textDescriptor = Object.getOwnPropertyDescriptor(MiniElement.prototype, "textContent");
        const innerDescriptor = Object.getOwnPropertyDescriptor(MiniElement.prototype, "innerHTML");
        expect(typeof textDescriptor.get).toBe("function");
        expect(textDescriptor.configurable).toBe(false);
        expect(typeof innerDescriptor.get).toBe("function");
        expect(typeof innerDescriptor.set).toBe("function");

        const originalOuter = Object.getOwnPropertyDescriptor(MiniElement.prototype, "outerHTML");
        try {
            Object.defineProperty(MiniElement.prototype, "outerHTML", {
                configurable: true,
                get: function () { return "<" + this.localName + ">"; },
                set: function (value) { this.__outerProbe = String(value); },
            });
            const document = createMiniDocument();
            const grid = document.createElement("div");
            document.body.appendChild(grid);
            const writes = [];
            Object.defineProperty(grid, "innerHTML", {
                configurable: true,
                get: function () { return innerDescriptor.get.call(grid); },
                set: function (markup) {
                    writes.push(String(markup));
                    innerDescriptor.set.call(grid, markup);
                },
            });
            grid.insertAdjacentHTML = function (position, markup) {
                expect(position).toBe("beforeend");
                const holder = document.createElement("div");
                holder.innerHTML = markup;
                const moving = holder.children.slice();
                moving.forEach(function (node) { grid.appendChild(node); });
            };

            grid.innerHTML = "<span>one</span>";
            grid.insertAdjacentHTML("beforeend", "<em>two</em>");
            grid.outerHTML = "replacement";

            expect(writes).toEqual(["<span>one</span>"]);
            expect(grid.children.length).toBe(2);
            expect(grid.textContent).toBe("onetwo");
            expect(grid.__outerProbe).toBe("replacement");
        } finally {
            if (originalOuter) Object.defineProperty(MiniElement.prototype, "outerHTML", originalOuter);
            else delete MiniElement.prototype.outerHTML;
        }
    });
});
