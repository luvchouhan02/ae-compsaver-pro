// ============================================================
// core/dom.js — generic DOM helpers
// ------------------------------------------------------------
// Tiny element-access helpers shared across every module. Each
// accepts either a cached-DOM key, an element id, or an element.
// Depends only on the global DOM cache (core/state.js) + document.
// Loaded before main.js; resolves as globals via the scope chain.
// ============================================================

function bindClick(idOrEl, fn) {
    var el = (typeof idOrEl === "string") ? DOM[idOrEl] || document.getElementById(idOrEl) : idOrEl;
    if (el) el.addEventListener("click", fn);
}

function setDisplay(el, val) {
    if (typeof el === "string") el = DOM[el] || document.getElementById(el);
    if (el) el.style.display = val;
}

function setActive(el, isActive) {
    if (typeof el === "string") el = DOM[el] || document.getElementById(el);
    if (el) el.classList.toggle("active", !!isActive);
}
