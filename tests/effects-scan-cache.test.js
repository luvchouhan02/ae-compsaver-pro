// ============================================================
// tests/effects-scan-cache.test.js
//
// Feature: effects preset scan containment (performance wave)
//
// What is under test
// ------------------
// The REAL Effects engine from js/toolkit/effects.js (loaded with
// core/node.js + core/settings.js into a vm realm), driven only through
// its public surface: scanEffectsFolder() and loadSavedEffects(force).
// Fixtures are disposable folders under os.tmpdir(); the legacy dir is
// pointed at a nonexistent path via an injected process.env.USERPROFILE,
// so no production library or user Documents folder is ever read.
//
// Contract (performance.effectsScanTtlMs wave):
//   1. A scan performs exactly ONE localStorage round-trip of the
//      original-names map (was: per-file re-parse/re-serialize).
//   2. The persisted map and originalName fields are equivalent to the
//      legacy behavior (new files map to their base name; pre-seeded
//      renames are honored).
//   3. loadSavedEffects() re-entry within the TTL skips the bridge
//      ensureFolder call, the watcher teardown, the scan, and the
//      re-render; force=true bypasses the gate.
//   4. TTL=0 restores always-rescan behavior.
//   5. A changed scan root (rootPath) invalidates freshness even within
//      the TTL.
// ============================================================
"use strict";

const nodeFs = require("fs");
const nodePath = require("path");
const os = require("os");
const vm = require("vm");

const ROOT = path_resolveRoot();
function path_resolveRoot() { return nodePath.resolve(__dirname, ".."); }

// ── Fixture isolation ───────────────────────────────────────────────────
function makeFixture(fileCount) {
    const tmpRoot = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "compsaver-effects-test-"));
    const activeRoot = nodePath.join(tmpRoot, "library");
    const effectsDir = nodePath.join(activeRoot, "effects");
    nodeFs.mkdirSync(nodePath.join(effectsDir, "GLOW"), { recursive: true });
    for (let i = 0; i < fileCount; i++) {
        const sub = i % 2 === 0 ? effectsDir : nodePath.join(effectsDir, "GLOW");
        nodeFs.writeFileSync(nodePath.join(sub, "Preset_" + String(i).padStart(3, "0") + ".ffx"), "test-fixture");
    }
    return { tmpRoot, activeRoot, effectsDir };
}

// ── Fake DOM / storage / bridge ─────────────────────────────────────────
function FakeElement(id) {
    this.id = id || "";
    this.innerHTML = "";
    this.textContent = "";
    this.className = "";
    this.style = {};
    this.dataset = {};
    this.parentNode = null;
    this._children = [];
    const self = this;
    this.classList = { add: function () { }, remove: function () { }, toggle: function () { }, contains: function () { return false; } };
}
FakeElement.prototype.appendChild = function (child) { child.parentNode = this; this._children.push(child); return child; };
FakeElement.prototype.addEventListener = function () { };
FakeElement.prototype.removeEventListener = function () { };
FakeElement.prototype.setAttribute = function () { };
FakeElement.prototype.getAttribute = function () { return null; };
FakeElement.prototype.contains = function () { return false; };
FakeElement.prototype.cloneNode = function () { return new FakeElement(this.id); };
FakeElement.prototype.replaceChild = function () { };

function buildRealm(fixture, seedMap) {
    const counts = { getItem: 0, setItem: 0, evalScript: 0 };
    const data = Object.create(null);
    if (seedMap) data["tk_effects_original_names"] = JSON.stringify(seedMap);
    const storage = {
        getItem: function (k) { counts.getItem++; return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
        setItem: function (k, v) { counts.setItem++; data[k] = String(v); },
        removeItem: function (k) { delete data[k]; },
        peek: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    };
    const ids = ["tk-effects-grid", "tk-menu-toggle-btn", "tk-dropdown-menu", "tk-category-badge", "tk-dropdown-list", "btn-tk-cat-all", "btn-tk-cat-fav"];
    const registry = {};
    for (const id of ids) {
        const el = new FakeElement(id);
        el.parentNode = new FakeElement(id + "-parent"); // setupEffectsControls does parentNode.replaceChild
        registry[id] = el;
    }
    const doc = {
        getElementById: function (id) { return registry[id] || null; },
        createElement: function (tag) { return new FakeElement(tag); },
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        addEventListener: function () { },
        removeEventListener: function () { },
    };
    const context = {
        console: { log: function () { }, warn: function () { }, error: function () { } },
        localStorage: storage,
        document: doc,
        process: { env: { USERPROFILE: nodePath.join(fixture.tmpRoot, "no-legacy"), HOME: nodePath.join(fixture.tmpRoot, "no-legacy") } },
        Date: Date,
        setTimeout: function (fn) { if (typeof fn === "function") fn(); return 0; },
        clearTimeout: function () { },
        setInterval: function () { return 0; },
        clearInterval: function () { },
        rootPath: fixture.activeRoot.replace(/\\/g, "/"),
        showToast: function () { },
        getSafeName: function (s) { return s; },
        escapeHTML: function (s) { return String(s); },
        escapeAttr: function (s) { return String(s); },
        bindClick: function () { },
        setDisplay: function () { },
        setActive: function () { },
        DOM: { on: function () { } },
        encodeBridge: function (s) { return String(s); },
        decodeBridge: function (s) { return String(s); },
        csInterface: { evalScript: function (script, cb) { counts.evalScript++; if (typeof cb === "function") cb(); } },
        require: function (name) {
            if (name === "fs") {
                const proxy = Object.assign(Object.create(null), nodeFs);
                proxy.watch = function () { throw new Error("test: watch disabled"); };
                return proxy;
            }
            if (name === "path") return nodePath;
            if (name === "os") return os;
            throw new Error("Unexpected require: " + name);
        },
    };
    context.window = { require: context.require, addEventListener: function () { } };
    vm.createContext(context);
    for (const file of ["js/core/node.js", "js/core/settings.js", "js/toolkit/effects.js"]) {
        vm.runInContext(nodeFs.readFileSync(nodePath.join(ROOT, file), "utf8"), context, { filename: file });
    }
    return { realm: context, counts, storage, registry };
}

function withFixture(fileCount, seedMap, fn) {
    const fixture = makeFixture(fileCount);
    try {
        fn(buildRealm(fixture, seedMap), fixture);
    } finally {
        try { nodeFs.rmSync(fixture.tmpRoot, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("Effects scan containment (performance wave)", () => {
    test("one scan performs exactly one localStorage round-trip of the names map", () => {
        withFixture(24, null, function (harness) {
            const before = { getItem: harness.counts.getItem, setItem: harness.counts.setItem };
            const files = harness.realm.scanEffectsFolder();
            const getItem = harness.counts.getItem - before.getItem;
            const setItem = harness.counts.setItem - before.setItem;
            expect(files.length).toBe(24);
            expect(getItem).toBe(1);   // was 2*N on a cold scan under the per-file pattern
            expect(setItem).toBe(1);   // was N
        });
    });

    test("persisted map and originalName fields match legacy semantics", () => {
        withFixture(6, { "Preset_003.ffx": "Renamed Glow" }, function (harness) {
            const files = harness.realm.scanEffectsFolder();
            const byFile = {};
            for (const f of files) byFile[f.file] = f;

            expect(byFile["Preset_003.ffx"].originalName).toBe("Renamed Glow");   // seeded rename honored
            expect(byFile["Preset_000.ffx"].originalName).toBe("Preset_000");      // new file → base name

            const persisted = JSON.parse(harness.storage.peek("tk_effects_original_names"));
            expect(Object.keys(persisted).length).toBe(6);
            expect(persisted["Preset_000.ffx"]).toBe("Preset_000");
            expect(persisted["Preset_003.ffx"]).toBe("Renamed Glow");              // seed not clobbered
        });
    });

    test("repeated warm scans never rewrite the map", () => {
        withFixture(10, null, function (harness) {
            harness.realm.scanEffectsFolder(); // cold: 1 getItem + 1 setItem
            const before = { getItem: harness.counts.getItem, setItem: harness.counts.setItem };
            harness.realm.scanEffectsFolder();
            harness.realm.scanEffectsFolder();
            expect(harness.counts.getItem - before.getItem).toBe(2);   // one per scan
            expect(harness.counts.setItem - before.setItem).toBe(0);   // map complete → no write
        });
    });

    test("loadSavedEffects re-entry within TTL skips bridge, scan and re-render", () => {
        withFixture(12, null, function (harness) {
            harness.realm.loadSavedEffects();
            expect(harness.counts.evalScript).toBe(1);          // boot: ensureFolder + scan ran
            const grid = harness.registry["tk-effects-grid"];
            const rendered = grid.innerHTML;
            expect(rendered.length).toBeGreaterThan(0);

            const before = { evalScript: harness.counts.evalScript, getItem: harness.counts.getItem };
            for (let i = 0; i < 10; i++) harness.realm.loadSavedEffects();
            expect(harness.counts.evalScript).toBe(before.evalScript);  // no bridge call
            expect(harness.counts.getItem).toBe(before.getItem);       // no scan
            expect(harness.registry["tk-effects-grid"].innerHTML).toBe(rendered); // grid untouched
        });
    });

    test("force=true bypasses the freshness gate", () => {
        withFixture(8, null, function (harness) {
            harness.realm.loadSavedEffects();
            harness.realm.loadSavedEffects(true);
            expect(harness.counts.evalScript).toBe(2);
        });
    });

    test("TTL=0 restores always-rescan behavior", () => {
        withFixture(8, null, function (harness) {
            expect(harness.realm.Settings.set("performance.effectsScanTtlMs", 0)).toBe(true);
            harness.realm.loadSavedEffects();
            harness.realm.loadSavedEffects();
            harness.realm.loadSavedEffects();
            expect(harness.counts.evalScript).toBe(3);
        });
    });

    test("a changed scan root invalidates freshness even within the TTL", () => {
        withFixture(8, null, function (harness, fixture) {
            harness.realm.loadSavedEffects();
            expect(harness.counts.evalScript).toBe(1);

            // User picks a new library root (settings-panel flow).
            const otherRoot = nodePath.join(fixture.tmpRoot, "library2", "effects").replace(/\\/g, "/");
            harness.realm.rootPath = otherRoot.replace(/\/effects$/, "");
            harness.realm.loadSavedEffects();
            expect(harness.counts.evalScript).toBe(2);  // roots differ → rescan despite fresh stamp
        });
    });
});
