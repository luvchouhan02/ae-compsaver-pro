// ============================================================
// tests/performance/effects-scan.bench.js
//
// Feature: effects preset scan containment (performance wave)
//
// What is measured
// ----------------
// The REAL Effects engine from js/toolkit/effects.js, loaded into a vm
// together with core/node.js and core/settings.js, driven only through
// its public surface (scanEffectsFolder / loadSavedEffects) against a
// disposable fixture folder under os.tmpdir(). No production library,
// user Documents folder, or AE instance is touched: the legacy dir is
// pointed at a nonexistent path inside the fixture sandbox via an
// injected `process.env.USERPROFILE`.
//
// Operations (same procedure before and after the wave):
//   scan-warm   — repeated scanEffectsFolder() with a complete
//                 original-names map (what every panel focus paid).
//   focus-burst — 20 consecutive loadSavedEffects() calls simulating
//                 focus flutter / click storms while the effects tab
//                 is active. Counts bridge ensureFolder calls and
//                 localStorage round-trips as queue/IO evidence.
//
// Run: node tests/performance/effects-scan.bench.js
// (Not a Jest file: testMatch only picks **/*.test.js.)
// ============================================================
"use strict";

const nodeFs = require("fs");
const nodePath = require("path");
const os = require("os");
const vm = require("vm");

const ROOT = path_resolveRoot();
function path_resolveRoot() {
    return nodePath.resolve(__dirname, "../..");
}

// ── Fixture isolation (mirrors contract-baseline assertIsolatedRuntimePath) ──
const TMP_ROOT = nodePath.join(os.tmpdir(), "compsaver-effects-bench-" + process.pid + "-" + Date.now());
const ACTIVE_ROOT = nodePath.join(TMP_ROOT, "library");
const EFFECTS_DIR_FIXTURE = nodePath.join(ACTIVE_ROOT, "effects");
const LEGACY_HOME = nodePath.join(TMP_ROOT, "fake-userprofile"); // no Documents/LAB_PRO_Effects inside

function assertIsolated(candidate) {
    const normalized = nodePath.resolve(candidate).toLowerCase();
    const tmp = nodePath.resolve(os.tmpdir()).toLowerCase();
    const project = ROOT.toLowerCase();
    if (!(normalized === tmp || normalized.indexOf(tmp + nodePath.sep) === 0)) {
        throw new Error("fixture escaped tmpdir: " + candidate);
    }
    if (normalized === project || normalized.indexOf(project + nodePath.sep) === 0) {
        throw new Error("fixture must not live inside the project: " + candidate);
    }
}

// ── Fixture builder ─────────────────────────────────────────────────────
const FILE_COUNT = Number(process.env.BENCH_FILES || 500);
const TOP_LEVEL = 150;
const CATEGORY_DIRS = ["GLOW", "BLUR", "COLOR", "DISTORT", "GENERATE", "TIME"];

function buildFixture() {
    assertIsolated(TMP_ROOT);
    nodeFs.mkdirSync(EFFECTS_DIR_FIXTURE, { recursive: true });
    nodeFs.mkdirSync(LEGACY_HOME, { recursive: true });
    let n = 0;
    for (let i = 0; i < TOP_LEVEL; i++, n++) {
        nodeFs.writeFileSync(nodePath.join(EFFECTS_DIR_FIXTURE, "Preset_" + pad(n) + ".ffx"), "bench-fixture");
    }
    for (let c = 0; c < CATEGORY_DIRS.length; c++) {
        const dir = nodePath.join(EFFECTS_DIR_FIXTURE, CATEGORY_DIRS[c]);
        nodeFs.mkdirSync(dir, { recursive: true });
        const per = Math.ceil((FILE_COUNT - TOP_LEVEL) / CATEGORY_DIRS.length);
        for (let i = 0; i < per && n < FILE_COUNT; i++, n++) {
            nodeFs.writeFileSync(nodePath.join(dir, "Preset_" + pad(n) + ".ffx"), "bench-fixture");
        }
    }
    return n;
}
function pad(n) { return String(n).padStart(4, "0"); }

function cleanupFixture() {
    try { nodeFs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

// ── Counting storage / bridge mocks ────────────────────────────────────
const counts = { getItem: 0, setItem: 0, evalScript: 0, watchAttempts: 0 };
function makeStorage() {
    const data = Object.create(null);
    return {
        getItem: function (k) { counts.getItem++; return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
        setItem: function (k, v) { counts.setItem++; data[k] = String(v); },
        removeItem: function (k) { delete data[k]; },
    };
}

// ── Minimal fake DOM (element machinery effects.js touches) ────────────
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
    this.classList = {
        add: function () { }, remove: function () { },
        toggle: function () { }, contains: function () { return false; },
    };
}
FakeElement.prototype.appendChild = function (child) { child.parentNode = this; this._children.push(child); return child; };
FakeElement.prototype.addEventListener = function () { };
FakeElement.prototype.removeEventListener = function () { };
FakeElement.prototype.setAttribute = function () { };
FakeElement.prototype.getAttribute = function () { return null; };
FakeElement.prototype.contains = function () { return false; };
FakeElement.prototype.cloneNode = function () { return new FakeElement(this.id); };
FakeElement.prototype.replaceChild = function () { };

function makeDocument() {
    const ids = ["tk-effects-grid", "tk-menu-toggle-btn", "tk-dropdown-menu",
        "tk-category-badge", "tk-dropdown-list", "btn-tk-cat-all", "btn-tk-cat-fav"];
    const registry = {};
    for (const id of ids) {
        const el = new FakeElement(id);
        el.parentNode = new FakeElement(id + "-parent"); // setupEffectsControls does parentNode.replaceChild
        registry[id] = el;
    }
    return {
        getElementById: function (id) { return registry[id] || null; },
        createElement: function (tag) { return new FakeElement(tag); },
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        addEventListener: function () { },
        removeEventListener: function () { },
    };
}

// ── vm realm: real sources + injected dependencies ─────────────────────
function buildRealm() {
    const storage = makeStorage();
    const doc = makeDocument();
    const context = {
        console: { log: function () { }, warn: function () { }, error: function () { } },
        localStorage: storage,
        document: doc,
        process: { env: { USERPROFILE: LEGACY_HOME, HOME: LEGACY_HOME } },
        Date: Date,
        setTimeout: function (fn) { if (typeof fn === "function") fn(); return 0; },
        clearTimeout: function () { },
        setInterval: function () { return 0; },
        clearInterval: function () { },
        rootPath: ACTIVE_ROOT.replace(/\\/g, "/"),
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
        csInterface: {
            evalScript: function (script, cb) {
                counts.evalScript++;
                if (typeof cb === "function") cb();
            },
        },
        require: function (name) {
            if (name === "fs") {
                // Real fs so readdirSync/statSync hit the fixture; watch() is
                // disabled so the bench never leaks OS watchers per iteration.
                const proxy = Object.assign(Object.create(null), nodeFs);
                proxy.watch = function () { counts.watchAttempts++; throw new Error("bench: watch disabled"); };
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
        const src = nodeFs.readFileSync(nodePath.join(ROOT, file), "utf8");
        vm.runInContext(src, context, { filename: file });
    }
    return context;
}

// ── Stats helpers ───────────────────────────────────────────────────────
function stats(samples) {
    const s = samples.slice().sort(function (a, b) { return a - b; });
    const rank = function (p) { return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
    return {
        n: s.length,
        min: s[0],
        p50: rank(0.50),
        p95: rank(0.95),
        max: s[s.length - 1],
    };
}
function fmt(st) {
    return "n=" + st.n + " min=" + st.min.toFixed(2) + "ms p50=" + st.p50.toFixed(2) + "ms p95=" + st.p95.toFixed(2) + "ms max=" + st.max.toFixed(2) + "ms";
}

// ── Bench operations ────────────────────────────────────────────────────
const WARM_RUNS = Number(process.env.BENCH_RUNS || 40);
const FOCUS_BURST = 20;

function main() {
    const files = buildFixture();
    const realm = buildRealm();
    console.log("[bench] fixture files=" + files + " activeDir=" + EFFECTS_DIR_FIXTURE);

    // Prime: one untimed scan fills the original-names map (steady state).
    realm.scanEffectsFolder();

    // Op A — scan-warm: repeated scan with complete map.
    const warm = [];
    for (let i = 0; i < WARM_RUNS; i++) {
        const t0 = process.hrtime.bigint();
        realm.scanEffectsFolder();
        warm.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }

    // Op B — focus-burst: 20 consecutive focus-driven reloads.
    const before = snapshotCounts();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < FOCUS_BURST; i++) realm.loadSavedEffects();
    const burstMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const during = deltaCounts(before);

    console.log("[bench] scan-warm:      " + fmt(stats(warm)));
    console.log("[bench] focus-burst(" + FOCUS_BURST + "): total=" + burstMs.toFixed(2) + "ms per-focus p50=" + (burstMs / FOCUS_BURST).toFixed(2) + "ms");
    console.log("[bench] burst evidence: localStorage.getItem=" + during.getItem +
        " localStorage.setItem=" + during.setItem +
        " bridge.evalScript=" + during.evalScript +
        " watchAttempts=" + during.watchAttempts);
}
function snapshotCounts() { return { getItem: counts.getItem, setItem: counts.setItem, evalScript: counts.evalScript, watchAttempts: counts.watchAttempts }; }
function deltaCounts(a) { const b = snapshotCounts(); return { getItem: b.getItem - a.getItem, setItem: b.setItem - a.setItem, evalScript: b.evalScript - a.evalScript, watchAttempts: b.watchAttempts - a.watchAttempts }; }

process.on("exit", cleanupFixture);
try {
    main();
} finally {
    cleanupFixture();
}
