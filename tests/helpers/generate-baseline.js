/**
 * One-shot generator for the Class Contract / DOM-inventory baseline fixture.
 *
 * Run with:  node tests/helpers/generate-baseline.js
 *
 * It captures the CURRENT committed state as the authoritative baseline. The
 * redesign preserved the Class Contract, so the current state is the correct
 * reference point: the contract test then fails only if a future change REMOVES
 * something the JavaScript depends on. Additions are always allowed.
 */

const fs = require("fs");
const path = require("path");
const SA = require("./static-analysis");

const html = SA.composeMarkup();
const allJs = SA.readAllJs();
const allCss = SA.readAllCss();

const htmlIds = SA.extractAllIds(html);
const interactiveIds = SA.extractInteractiveIds(html);
const htmlClasses = SA.extractHtmlClasses(html);
const htmlDataAttrs = SA.extractHtmlDataAttrs(html);

const cssClasses = SA.extractCssClasses(allCss);
const cssDataAttrs = SA.extractCssDataAttrs(allCss);

const jsRefs = SA.extractJsRefs(allJs);
const selectorDataAttrs = SA.dataAttrsFromSelectors(jsRefs.selectors);

const sorted = (set) => Array.from(set).sort();

// JS-referenced ids that resolve to a STATIC element in index.html today.
// (Dynamically-created ids are excluded — they are not part of the static contract.)
const jsStaticIds = sorted(jsRefs.ids).filter((id) => htmlIds.has(id));

// JS classList classes that resolve today (present in HTML markup OR have a CSS rule).
const allDataAttrs = new Set([...jsRefs.dataAttrs, ...selectorDataAttrs]);
const jsResolvableClasses = sorted(jsRefs.classes).filter(
    (c) => htmlClasses.has(c) || cssClasses.has(c)
);

// JS-referenced data-* attributes that resolve today (authored in HTML OR used in CSS).
const jsResolvableDataAttrs = sorted(allDataAttrs).filter(
    (d) => htmlDataAttrs.has(d) || cssDataAttrs.has(d)
);

const baseline = {
    _comment:
        "Baseline captured from the committed state (panel-visual-redesign task 13.2). " +
        "The contract test asserts every entry below is still satisfied; additions are allowed.",
    interactiveIds: sorted(interactiveIds),
    jsStaticIds,
    jsResolvableClasses,
    jsResolvableDataAttrs,
};

const outPath = path.join(SA.ROOT, "tests", "fixtures", "class-contract.baseline.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(baseline, null, 4) + "\n", "utf8");

console.log("Wrote baseline to", outPath);
console.log("interactiveIds:", baseline.interactiveIds.length);
console.log("jsStaticIds:", baseline.jsStaticIds.length);
console.log("jsResolvableClasses:", baseline.jsResolvableClasses.length);
console.log("jsResolvableDataAttrs:", baseline.jsResolvableDataAttrs.length);
