// ============================================================
// tests/performance/toolkit-bridge.bench.js
//
// Feature: Toolkit quality wave — before/after timing evidence
//
// Measures, on this machine, in Node (panel-side proxy costs; AE host
// times require the manual in-app matrix):
//   1. paste-temp-write: synchronous writeFileSync of a 4K-screenshot-
//      sized buffer (the OLD on-click UI-thread block) vs the new
//      asynchronous fs.writeFile dispatch cost (what the UI thread
//      actually pays now).
//   2. toolbridge-overhead: wrapper dispatch cost per operation with
//      an immediately-responding host.
//   3. colorflow-live-throttle: host calls for a simulated 60-event
//      drag burst (16ms spacing) — old per-mousemove vs new throttled.
//   4. crop-usage-scan: full-project layer reads for a 6-selected-
//      precomp crop on a synthetic 300-comp/6000-layer project —
//      old per-layer scans vs the new single-pass map.
//
// Run: node tests/performance/toolkit-bridge.bench.js
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "../..");

function stats(samples) {
    const s = samples.slice().sort((a, b) => a - b);
    const rank = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
    return { n: s.length, p50: rank(0.5), p95: rank(0.95) };
}
function fmt(st, unit) {
    return "n=" + st.n + " p50=" + st.p50.toFixed(3) + unit + " p95=" + st.p95.toFixed(3) + unit;
}

// ── 1. Paste temp write: sync block vs async dispatch ───────────────────
function benchPasteWrite() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compsaver-pastewrite-"));
    const buffer = Buffer.alloc(4 * 1024 * 1024, 7); // ~4K PNG screenshot size
    const RUNS = 30;
    const sync = [];
    for (let i = 0; i < RUNS; i++) {
        const t0 = process.hrtime.bigint();
        fs.writeFileSync(path.join(tmp, "sync.png"), buffer);
        sync.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const asyncDispatch = [];
    let done = 0;
    for (let i = 0; i < RUNS; i++) {
        const t0 = process.hrtime.bigint();
        fs.writeFile(path.join(tmp, "async" + i + ".png"), buffer, () => {
            done++;
            if (done === RUNS) {
                fs.rmSync(tmp, { recursive: true, force: true });
                report();
            }
        });
        asyncDispatch.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    function report() {
        console.log("[bench] paste-write sync (OLD, blocks UI thread): " + fmt(stats(sync), "ms"));
        console.log("[bench] paste-write async dispatch (NEW, UI-thread cost): " + fmt(stats(asyncDispatch), "ms"));
    }
}

// ── 2. ToolBridge dispatch overhead ─────────────────────────────────────
function benchToolBridge() {
    const source = fs.readFileSync(path.join(ROOT, "js/core/toolBridge.js"), "utf8");
    const context = {
        console: { log() { }, warn() { }, error() { } },
        performance: { now: () => Date.now() },
        setTimeout: function (fn) { fn(); return 0; }, // not used on success path
        clearTimeout() { },
        showToast() { },
        decodeBridge: (s) => String(s),
        csInterface: { evalScript(script, cb) { cb("4f4b"); } },
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "toolBridge.js" });
    const TB = context.ToolBridge;
    const samples = [];
    for (let i = 0; i < 10000; i++) {
        const t0 = process.hrtime.bigint();
        TB.call({ key: "bench-" + i, script: "bench()", onResult() { } });
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    console.log("[bench] toolbridge dispatch overhead: " + fmt(stats(samples), "ms"));
}

// ── 3. ColorFlow live-drag throttle ────────────────────────────────────
function benchColorFlowThrottle() {
    const source = fs.readFileSync(path.join(ROOT, "js/toolkit/colorflow.js"), "utf8");
    const hostCalls = [];
    const timers = [];
    const context = {
        console: { log() { }, warn() { }, error() { } },
        localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
        document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, createElement: () => null, addEventListener() { } },
        showToast() { },
        encodeBridge: (s) => String(s),
        decodeBridge: (s) => String(s),
        setTimeout: (fn, ms) => { timers.push({ fn, at: Number(ms) || 0 }); return timers.length; },
        clearTimeout: (handle) => { if (handle >= 1 && handle <= timers.length) delete timers[handle - 1]; },
        setInterval() { return 0; },
        clearInterval() { },
        csInterface: { evalScript(script, cb) { hostCalls.push(script); if (cb) cb("4f4b"); } },
        ToolBridge: {
            call(opts) {
                hostCalls.push(opts.script);
                opts.onResult({ status: "success", decoded: "true" });
            },
        },
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: "colorflow.js" });

    // Old behavior proxy: every mousemove = one evalScript.
    const oldCalls = hostCalls.length;
    const burst = 60; // ~1s drag at 16ms event spacing
    for (let i = 0; i < burst; i++) {
        context.ColorFlow.applyColor("#ff0000", "fill"); // OLD path (applyColor direct)
    }
    const oldCount = hostCalls.length - oldCalls;

    // New behavior: applyColorLive with a virtual clock advancing 16ms per
    // move, then fire whatever trailing timer remains.
    const newBase = hostCalls.length;
    const realmPatch = "Date.now = (function(){ var t = " + Date.now() + "; return function(){ return t += 16; }; })();";
    vm.runInContext(realmPatch, context);
    for (let i = 0; i < burst; i++) {
        context.ColorFlow.applyColorLive("#ff0000", "fill");
    }
    for (const t of timers.splice(0)) { if (t) t.fn(); }
    const newCount = hostCalls.length - newBase;

    console.log("[bench] colorflow live drag (" + burst + " moves): OLD host calls=" + oldCount + " NEW host calls=" + newCount);
}

// ── 4. Crop usage scans: old per-layer vs new single pass ───────────────
function benchCropScans() {
    const text = fs.readFileSync(path.join(ROOT, "jsx/text.jsx"), "utf8");
    function extract(name) {
        const start = text.indexOf("function " + name + "(");
        const next = text.indexOf("\nfunction ", start + 1);
        return text.slice(start, next === -1 ? text.length : next);
    }
    function CompItem() { }
    function AVLayer() { }
    const COMPS = 300, LAYERS = 20;
    const items = [];
    for (let c = 0; c < COMPS; c++) {
        const comp = new CompItem();
        comp.id = c + 1;
        comp.__layers = [];
        for (let l = 0; l < LAYERS; l++) {
            const layer = new AVLayer();
            layer.source = items[c > 0 ? 0 : 0] || null; // reference comp #1 (shared)
            comp.__layers.push(layer);
        }
        comp.numLayers = LAYERS;
        comp.layer = function (i) { return this.__layers[i - 1]; };
        items.push(comp);
    }
    // Give layers sources AFTER items exist (comp 1 as shared source).
    for (const comp of items) {
        for (const layer of comp.__layers) layer.source = items[0];
    }
    const project = { numItems: items.length, item: (i) => items[i - 1] };

    const context = { app: { project }, CompItem, AVLayer };
    vm.createContext(context);
    vm.runInContext(extract("getSourceCompUsageCount"), context, { filename: "getSourceCompUsageCount" });
    vm.runInContext(extract("buildSourceUsageCountMap"), context, { filename: "buildSourceUsageCountMap" });

    const K = 6; // selected precomp layers
    const t0 = process.hrtime.bigint();
    let readsOld = 0;
    // OLD: preflight once per selected layer + exec once per precomp.
    for (let i = 0; i < 2 * K; i++) context.getSourceCompUsageCount(items[0]);
    const oldMs = Number(process.hrtime.bigint() - t0) / 1e6;

    const t1 = process.hrtime.bigint();
    context.buildSourceUsageCountMap();
    const newMs = Number(process.hrtime.bigint() - t1) / 1e6;

    console.log("[bench] crop usage scan (" + COMPS + " comps x " + LAYERS + " layers, " + K + " selected): OLD=" + oldMs.toFixed(2) + "ms (2 full scans/layer) NEW=" + newMs.toFixed(2) + "ms (1 scan total)");
}

benchPasteWrite();
benchToolBridge();
benchColorFlowThrottle();
benchCropScans();
