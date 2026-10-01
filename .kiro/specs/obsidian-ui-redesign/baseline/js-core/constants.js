// ============================================================
// core/constants.js — shared, immutable lookup tables
// ------------------------------------------------------------
// Pure data only. Loaded before main.js so these resolve as
// globals from inside the main IIFE's scope chain. No logic,
// no DOM, no state — safe to include anywhere.
// ============================================================

var SECTIONS = {
    COMP: "comp",
    LAYER: "layer",
    TEXT: "text",
    TEXT_PROPS: "text_props",
    FOOTAGE: "footage",
    EFFECT: "effect",
    ICON: "icon",
    OVERLAY: "overlay",
    ELEMENT: "element"
};

var IMAGE_SECTIONS = [SECTIONS.ICON, SECTIONS.OVERLAY, SECTIONS.ELEMENT];

var MODULES = {
    TOOLKIT: "toolkit",
    TEMPLATES: "templates",
    SETTINGS: "settings"
};

var GRID_IDS = [
    "comp-list-container",
    "icon-list-container",
    "transition-list-container",
    "text-list-container",
    "footage-list-container",
    "effect-list-container"
];

var TEMPLATE_SECTION_IDS = [
    "section-comp",
    "section-images",
    "section-transition",
    "section-text",
    "section-footage",
    "section-effect"
];
