"use strict";

const fc = require("fast-check");
const CollectionController = require("../js/ui/collection-controller");

function fakeScheduler(ignoreCancellation) {
    let now = 0;
    let nextId = 1;
    const tasks = [];
    function add(fn, delay) {
        const token = { id: nextId++, due: now + (delay || 0), fn, cancelled: false };
        tasks.push(token);
        return token;
    }
    function cancel(token) {
        if (token && !ignoreCancellation) token.cancelled = true;
    }
    function advance(ms) {
        const target = now + ms;
        while (true) {
            tasks.sort((a, b) => a.due - b.due || a.id - b.id);
            const task = tasks.find((candidate) => !candidate.cancelled && candidate.due <= target);
            if (!task) break;
            tasks.splice(tasks.indexOf(task), 1);
            now = task.due;
            task.fn();
        }
        now = target;
    }
    return { setTimeout: add, clearTimeout: cancel, requestFrame: (fn) => add(fn, 0), cancelFrame: cancel, advance };
}

function settings(values) {
    return {
        get(key) { return values[key]; },
        onChange() { return function () { }; },
    };
}

class FakeNode {
    constructor() { this.attrs = {}; }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
}

class FakeContainer {
    constructor() { this.children = []; }
    insertBefore(node, before) {
        const current = this.children.indexOf(node);
        if (current !== -1) this.children.splice(current, 1);
        if (before === null) this.children.push(node);
        else this.children.splice(this.children.indexOf(before), 0, node);
    }
    removeChild(node) { this.children.splice(this.children.indexOf(node), 1); }
}

function readyView(records, selectedIds, overrides) {
    const derived = CollectionController.deriveCollection(records, overrides || {});
    return CollectionController.createViewModel({
        sourceState: "ready", derived, selectedIds: selectedIds || [],
        cardSize: "small", density: "compact",
    });
}
describe("CollectionController pure derivation and view models", () => {
    test("derives filtered, stably sorted results without mutating domain records", () => {
        const records = [
            { id: "b", name: "Beta", category: "motion", favorite: true },
            { id: "a", name: "Alpha", category: "motion", favorite: true },
            { id: "c", name: "Alpha", category: "still", favorite: true },
        ];
        const before = JSON.stringify(records);
        const result = CollectionController.deriveCollection(records, {
            query: "a", filters: { category: "motion", favorite: true }, sort: "name-asc",
        });
        expect(result.visibleIds).toEqual(["a", "b"]);
        expect(result.allIds).toEqual(["b", "a", "c"]);
        expect(JSON.stringify(records)).toBe(before);
    });

    test("exposes all seven required view kinds distinctly", () => {
        const populated = CollectionController.deriveCollection([{ id: "one", name: "One" }]);
        const empty = CollectionController.deriveCollection([]);
        const filtered = CollectionController.deriveCollection([{ id: "one", name: "One" }], { query: "missing" });
        const kinds = [
            CollectionController.createViewModel({ sourceState: "loading", derived: empty }).kind,
            CollectionController.createViewModel({ sourceState: "ready", derived: populated }).kind,
            CollectionController.createViewModel({ sourceState: "ready", derived: empty }).kind,
            CollectionController.createViewModel({ sourceState: "ready", derived: filtered }).kind,
            CollectionController.createViewModel({ sourceState: "unavailable", derived: empty }).kind,
            CollectionController.createViewModel({ sourceState: "unreadable", derived: empty }).kind,
            CollectionController.createViewModel({ sourceState: "placeholder", derived: populated }).kind,
        ];
        expect(kinds).toEqual(CollectionController.VIEW_KINDS);
        expect(new Set(kinds).size).toBe(7);
    });

    test("fails closed for missing/duplicate IDs and invalid discriminators", () => {
        expect(() => CollectionController.deriveCollection([{ name: "missing" }])).toThrow("COLLECTION_ID_INVALID");
        expect(() => CollectionController.deriveCollection([{ id: "x" }, { id: "x" }])).toThrow("COLLECTION_ID_DUPLICATE");
        expect(() => CollectionController.createViewModel({ sourceState: "degraded" })).toThrow("COLLECTION_STATE_INVALID");
        expect(() => CollectionController.validateDebounce(49)).toThrow("SEARCH_DEBOUNCE_INVALID");
        expect(() => CollectionController.create({ autoRender: false, cardSize: "giant" })).toThrow("CARD_SIZE_INVALID");
        expect(() => CollectionController.create({ autoRender: false, density: "dense" })).toThrow("DENSITY_INVALID");
    });
});

describe("CollectionController scheduling and semantic state", () => {
    test("uses configured debounce and commits only after its quiet period", () => {
        const clock = fakeScheduler(false);
        const commits = [];
        const controller = CollectionController.create({
            autoRender: false, scheduler: clock,
            settings: settings({
                "performance.searchDebounce": 120,
                "ui.templateCardSize": "medium",
                "ui.density": "expanded",
            }),
            sourceState: "ready", records: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }],
            commit(view) { commits.push(view); },
        });
        controller.setQuery("alp");
        clock.advance(119);
        expect(commits).toHaveLength(0);
        clock.advance(1);
        expect(commits).toHaveLength(1);
        expect(commits[0].visibleIds).toEqual(["a"]);
        expect(commits[0].cardSize).toBe("medium");
        expect(commits[0].density).toBe("expanded");
    });

    test("rejects stale derive and commit callbacks even when cancellation is ineffective", () => {
        const clock = fakeScheduler(true);
        const commits = [];
        const controller = CollectionController.create({
            autoRender: false, scheduler: clock, searchDebounce: 100,
            sourceState: "ready", records: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }],
            commit(view) { commits.push({ generation: view.generation, query: view.query }); },
        });
        controller.setQuery("alpha");
        clock.advance(50);
        controller.setQuery("beta");
        clock.advance(100);
        expect(commits).toEqual([{ generation: 2, query: "beta" }]);
    });

    test("preserves ID selection across filtering, sorting, and record recreation", () => {
        const controller = CollectionController.create({
            autoRender: false, sourceState: "ready",
            records: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }],
        });
        controller.setSelectedIds(["b"]);
        controller.setQuery("alpha");
        controller.setSort("name-desc");
        controller.setRecords([{ id: "b", name: "Beta 2" }, { id: "a", name: "Alpha 2" }]);
        const view = controller.flush();
        expect(view.selectedIds).toEqual(["b"]);
        expect(view.visibleSelectedIds).toEqual([]);
        expect(view.visibleIds).toEqual(["a"]);
    });
});
describe("CollectionController keyed DOM commits", () => {
    test("patches only the changed key and preserves node identity", () => {
        const container = new FakeContainer();
        const patches = [];
        const adapter = {
            create(record, key) { const node = new FakeNode(); node.value = record.name; node.key = key; return node; },
            patch(node, record, key) { node.value = record.name; patches.push(key); },
        };
        const first = CollectionController.commitKeyed(container, readyView([
            { id: "a", name: "Alpha" }, { id: "b", name: "Beta" },
        ]), adapter);
        const nodeA = container.children[0];
        const nodeB = container.children[1];
        expect(first.created).toEqual(["a", "b"]);

        const second = CollectionController.commitKeyed(container, readyView([
            { id: "a", name: "Alpha" }, { id: "b", name: "Beta updated" },
        ]), adapter);
        expect(second.patched).toEqual(["b"]);
        expect(patches).toEqual(["b"]);
        expect(container.children[0]).toBe(nodeA);
        expect(container.children[1]).toBe(nodeB);
    });

    test("performs keyed create, move, and remove without replacing unaffected nodes", () => {
        const container = new FakeContainer();
        const adapter = { create() { return new FakeNode(); } };
        CollectionController.commitKeyed(container, readyView([
            { id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" },
        ]), adapter);
        const nodes = Object.fromEntries(container.children.map((node) => [node.getAttribute("data-collection-key"), node]));
        const result = CollectionController.commitKeyed(container, readyView([
            { id: "c", name: "C" }, { id: "b", name: "B" }, { id: "d", name: "D" },
        ]), adapter);
        expect(container.children.map((node) => node.getAttribute("data-collection-key"))).toEqual(["c", "b", "d"]);
        expect(container.children[0]).toBe(nodes.c);
        expect(container.children[1]).toBe(nodes.b);
        expect(result.removed).toEqual(["a"]);
        expect(result.created).toEqual(["d"]);
    });
});

describe("CollectionController ID-state property", () => {
    test("selection remains attached to IDs for arbitrary record reorders", () => {
        // **Validates: Requirements 7.2, 18.3**
        fc.assert(fc.property(
            fc.uniqueArray(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 30 }),
            fc.integer({ min: 0, max: 1000 }),
            (ids, seed) => {
                const records = ids.map((id) => ({ id: String(id), name: "item-" + id }));
                const selected = String(ids[Math.abs(seed) % ids.length]);
                const reordered = records.slice().sort((a, b) => ((Number(a.id) + seed) % 7) - ((Number(b.id) + seed) % 7));
                const controller = CollectionController.create({ autoRender: false, sourceState: "ready", records });
                controller.setSelectedIds([selected]);
                controller.setRecords(reordered.map((record) => ({ id: record.id, name: record.name })));
                return JSON.stringify(controller.flush().selectedIds) === JSON.stringify([selected]);
            }
        ), { numRuns: 100 });
    });
});
