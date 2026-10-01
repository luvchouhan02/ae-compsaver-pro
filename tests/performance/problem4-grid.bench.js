// ============================================================
// tests/performance/problem4-grid.bench.js
//
// Feature: Problem 4 — library grid scale-out (150 / 1,000 / 5,000)
//
// BEFORE = verbatim transcription of the pre-P4 algorithms
// (getSectionTemplates full scan, O(N*C) category counting,
// per-switch tab+panel rebuild, full-list innerHTML mount).
// AFTER  = the REAL js/templates/templateCatalog.js +
// js/templates/virtualGrid.js + the real renderTemplateCardMarkup
// sliced out of templates.js, in one vm realm with a layout-stub
// DOM (fixed columns/row height; DOM parse cost itself is CEF-side
// and covered by the manual in-panel matrix).
//
// Run: node tests/performance/problem4-grid.bench.js
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "../..");
const CATALOG_SRC = fs.readFileSync(path.join(ROOT, "js/templates/templateCatalog.js"), "utf8");
const VGRID_SRC = fs.readFileSync(path.join(ROOT, "js/templates/virtualGrid.js"), "utf8");
const TPL_SRC = fs.readFileSync(path.join(ROOT, "js/templates/templates.js"), "utf8");

function sliceFn(src, name) {
    const start = src.indexOf("function " + name + "(");
    if (start === -1) throw new Error("missing " + name);
    let depth = 0, i = src.indexOf("{", start);
    for (let j = i; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error("unbalanced " + name);
}

const COLUMNS = 8, ROW_H = 176, VIEWPORT_H = 620;
let mountedCards = 0;
let builtNodes = 0;

function fakeEl(tag) {
    const el = {
        tagName: tag, children: [], attrs: {}, dataset: {}, style: {},
        _html: "", scrollTop: 0, clientHeight: VIEWPORT_H, clientWidth: 576,
        offsetHeight: tag === "div" && Math.random() < 0 ? 0 : ROW_H,
        classList: {
            add() { }, remove() { }, toggle() { }, contains() { return false; },
        },
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        appendChild(c) {
            if (c.parentNode && c.parentNode.children) {
                const oi = c.parentNode.children.indexOf(c);
                if (oi > -1) c.parentNode.children.splice(oi, 1);
            }
            this.children.push(c); c.parentNode = this; return c;
        },
        removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; },
        addEventListener() { }, removeEventListener() { },
        querySelector(sel) {
            if (sel === ".card:not(.vg-spacer)") return this.children.find((c) => c._isCard) || null;
            if (sel === ".cat-pill" || sel === ".cat-panel-item" || sel === ".cat-count") {
                return this.children.find((c) => c._sel === sel) || null;
            }
            return null;
        },
        querySelectorAll(sel) { return this.children.filter((c) => c._sel === sel || (sel === ".cat-pill" && c._isPill)); },
        get firstChild() { return this.children[0] || null; },
    };
    Object.defineProperty(el, "innerHTML", {
        get() { return this._html; },
        set(html) {
            this._html = String(html);
            this.children.length = 0;
            // Count real card mounts for the gate check.
            const cards = (this._html.match(/class="card/g) || []).length;
            if (cards) {
                mountedCards += cards; builtNodes += cards;
                for (let i = 0; i < cards; i++) {
                    const c = fakeEl("div"); c._isCard = true; c.offsetHeight = ROW_H;
                    this.children.push(c); c.parentNode = this;
                }
            }
        },
    });
    if (tag === "div") { el.replaceChildren = function (...nodes) { this.children.length = 0; for (const n of nodes) { if (n && n._isFragment) { for (const fc of n.children) this.appendChild(fc); } else this.appendChild(n); } }; }
    return el;
}

function buildRealm() {
    const registry = {};
    for (const id of ["comp-list-container", "category-tabs", "cat-panel-list", "search-box"]) {
        const el = fakeEl("div"); el.id = id; registry[id] = el;
    }
    const context = {
        console: { log() { }, warn() { }, error() { } },
        document: {
            getElementById: (id) => registry[id] || null,
            createElement: (t) => fakeEl(t),
            createDocumentFragment: () => { const f = fakeEl("#frag"); f._isFragment = true; return f; },
        },
        window: {
            getComputedStyle: () => ({
                gridTemplateColumns: (COLUMNS - 1) ? Array(COLUMNS).fill("72px").join(" ") : "72px",
                rowGap: "8px",
            }),
            addEventListener() { },
            requestAnimationFrame: null,
        },
        requestAnimationFrame: (fn) => { fn(); return 0; },
        escapeHTML: (s) => String(s),
        escapeAttr: (s) => String(s),
        setTimeout: (fn) => { fn(); return 0; },
        clearTimeout() { },
        SECTIONS: { COMP: "comp", LAYER: "layer", TEXT: "text", FOOTAGE: "footage", EFFECT: "effect" },
    };
    vm.createContext(context);
    vm.runInContext(CATALOG_SRC, context, { filename: "templateCatalog.js" });
    vm.runInContext(VGRID_SRC, context, { filename: "virtualGrid.js" });
    vm.runInContext(sliceFn(TPL_SRC, "escapeTemplateCardAttribute"), context, { filename: "esc.js" });
    vm.runInContext(sliceFn(TPL_SRC, "renderTemplateCardMarkup"), context, { filename: "cardMarkup.js" });
    context.VirtualGrid.init({ markupFor: context.renderTemplateCardMarkup, requestAnimationFrame: context.requestAnimationFrame });
    context.__registry = registry;
    return context;
}

// ── Fixtures ────────────────────────────────────────────────────────────
const SECTIONS = ["comp", "layer", "text", "footage", "effect", "icon", "overlay"];
const CATS = ["Glow", "Blur", "Color", "Distort", "Generate", "Time", "Perspective", "Stylize", "Transitions", "3D", "Legacy", "WIP"];
function makeRecords(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({
            id: "r" + i,
            name: "Template " + String(i).padStart(5, "0"),
            category: CATS[i % CATS.length],
            section: SECTIONS[i % SECTIONS.length],
            favorite: i % 5 === 0,
            thumbnail: "C:/lib/t" + i + "/thumb.png",
            folderPath: "C:/lib/t" + i,
            type: "media", dim: "1920x1080",
        });
    }
    return out;
}

// ── BEFORE: verbatim pre-P4 algorithms ─────────────────────────────────
function beforeSwitch(records, section, category, query) {
    const tabs = [], panelRows = [];
    // getSectionTemplates
    const sectionTemplates = [];
    for (let i = 0; i < records.length; i++) if (records[i].section === section) sectionTemplates.push(records[i]);
    // getSectionCategories
    const cats = ["All", "Favorites"];
    for (let i = 0; i < sectionTemplates.length; i++) {
        const c = sectionTemplates[i].category;
        if (c && cats.indexOf(c) === -1) cats.push(c);
    }
    // buildCategoryTabs + buildCategoryPanel (counts O(N*C))
    let countWork = 0;
    for (let ci = 0; ci < cats.length; ci++) {
        let count;
        if (cats[ci] === "All") count = sectionTemplates.length;
        else if (cats[ci] === "Favorites") { count = 0; for (let j = 0; j < sectionTemplates.length; j++) { countWork++; if (sectionTemplates[j].favorite) count++; } }
        else { count = 0; for (let k = 0; k < sectionTemplates.length; k++) { countWork++; if (sectionTemplates[k].category === cats[ci]) count++; } }
        tabs.push(cats[ci]); panelRows.push(count);
    }
    // filterAndRender
    const filtered = [];
    for (let i = 0; i < sectionTemplates.length; i++) {
        const t = sectionTemplates[i];
        if (category === "Favorites" && !t.favorite) continue;
        if (category !== "All" && category !== "Favorites" && t.category !== category) continue;
        if (query) {
            const hay = ((t.name || "") + " " + (t.category || "") + " " + (t.type || "") + " " + (t.section || "") + " " + (t.dim || "")).toLowerCase();
            if (hay.indexOf(query) === -1) continue;
        }
        filtered.push(t);
    }
    // renderCards: full innerHTML — with the REAL card markup (the string
    // build was the dominant pre-P4 switch cost; CEF-side parse is extra).
    if (filtered.length === 0) return { mounted: 0 };
    const html = [];
    for (let i = 0; i < filtered.length; i++) html.push(realMarkup(filtered[i], section, []));
    const joined = html.join("");
    const grid = beforeGrid;
    grid.children.length = 0;
    let mounted = 0;
    for (let i = 0; i < filtered.length; i++) { mounted++; grid.children.push({ _isCard: true }); }
    return { mounted, bytes: joined.length };
}
let beforeGrid = { children: [] };
let realMarkup = () => '<div class="card"></div>';

// ── Stats ───────────────────────────────────────────────────────────────
function stats(samples) {
    const s = samples.slice().sort((a, b) => a - b);
    const rank = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
    return { n: s.length, p50: rank(0.5), p95: rank(0.95) };
}

// ── Run ─────────────────────────────────────────────────────────────────
for (const N of [150, 1000, 5000]) {
    const records = makeRecords(N);
    const section = "comp";

    for (const category of ["Glow", "All"]) {
        // BEFORE (real markup)
        const realm0 = buildRealm();
        realMarkup = realm0.renderTemplateCardMarkup;
        const beforeSamples = [];
        let beforeMounted = 0, beforeBytes = 0;
        for (let i = 0; i < 20; i++) {
            const t0 = process.hrtime.bigint();
            const r = beforeSwitch(records, section, category, "");
            beforeSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
            beforeMounted = r.mounted; beforeBytes = r.bytes || 0;
        }

        // AFTER (real modules)
        const realm = buildRealm();
        realm.TemplateCatalog.build(records, (t) => t.section);
        const grid = realm.__registry["comp-list-container"];
        const afterSamples = [];
        let afterMounted = 0;
        for (let i = 0; i < 20; i++) {
            const t0 = process.hrtime.bigint();
            const ids = realm.TemplateCatalog.idsFor(section, category, "");
            const mounted = realm.VirtualGrid.render("comp-list-container", grid, section + "|" + category + "|", ids, { section });
            afterSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
            afterMounted = mounted;
        }

        const b = stats(beforeSamples), a = stats(afterSamples);
        console.log("[N=" + String(N).padStart(4) + " cat=" + String(category).padEnd(4) + "] switch BEFORE p50=" + b.p50.toFixed(2) + "ms p95=" + b.p95.toFixed(2) + "ms (" + (beforeBytes / 1024).toFixed(0) + "KB html)  AFTER p50=" + a.p50.toFixed(2) + "ms p95=" + a.p95.toFixed(2) + "ms");
        console.log("[N=" + String(N).padStart(4) + " cat=" + String(category).padEnd(4) + "] mounted cards per view BEFORE=" + beforeMounted + "  AFTER=" + afterMounted);
    }
}

// Search correctness spot-check at N=5000 (first/last card identity)
{
    const records = makeRecords(5000);
    const realm = buildRealm();
    realm.TemplateCatalog.build(records, (t) => t.section);
    const ids = realm.TemplateCatalog.idsFor("comp", "All", "template 0499");
    const first = realm.TemplateCatalog.get(ids[0]);
    const brute = records.filter((t) => t.section === "comp" && ((t.name + " " + t.category + " " + t.type + " " + t.section + " " + t.dim).toLowerCase().indexOf("template 0499") !== -1));
    console.log("[check] search 'template 0499': catalog=" + ids.length + " brute=" + brute.length + " firstMatch=" + (first && first.name));
}
