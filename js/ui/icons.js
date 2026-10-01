// ============================================================
// ui/icons.js — CompSaver Brand & Modern SVG Icon System
// ------------------------------------------------------------
// All-new, production-grade vector icon set. CEP-safe,
// dependency-free, inline currentColor SVGs on 20px grid.
// ============================================================

var CompSaverIcons = (function () {
    "use strict";

    var GRID = 20;
    var STROKE = 1.5;
    var definitions = {};
    var families = {
        universal: [], navigation: [], library: [], toolkit: [], preset: [],
        easing: [], colorflow: [], settings: [], status: [], feedback: []
    };
    var emptyArt = {};

    function add(name, family, body, filledState) {
        if (definitions[name]) throw new Error("Duplicate icon: " + name);
        definitions[name] = {
            name: name,
            family: family,
            body: body,
            filledState: filledState === true
        };
        if (!families[family]) families[family] = [];
        families[family].push(name);
    }

    function art(name, body) {
        if (emptyArt[name]) throw new Error("Duplicate empty-state art: " + name);
        emptyArt[name] = { name: name, body: body };
    }

    // --- Universal Actions ---
    add("add", "universal", '<path d="M10 4v12M4 10h12"/>');
    add("remove", "universal", '<path d="M4 10h12"/>');
    add("close", "universal", '<path d="M5 5l10 10M15 5L5 15"/>');
    add("check", "universal", '<path d="M4 10.5l4 4 8-9"/>');
    add("search", "universal", '<circle cx="9" cy="9" r="5"/><path d="M13 13l4.5 4.5"/>');
    add("filter", "universal", '<path d="M3.5 4.5h13l-5 6v5l-3 1.5v-6.5z"/>');
    add("sort", "universal", '<path d="M6 3.5v13m0 0l-2.5-2.5M6 16.5l2.5-2.5M14 16.5v-13m0 0l-2.5 2.5M14 3.5l2.5 2.5"/>');
    add("more", "universal", '<circle cx="4.5" cy="10" r="1.25" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.25" fill="currentColor" stroke="none"/><circle cx="15.5" cy="10" r="1.25" fill="currentColor" stroke="none"/>', true);
    add("menu", "universal", '<path d="M3.5 5h13M3.5 10h13M3.5 15h13"/>');
    add("chevron-up", "universal", '<path d="M5 12.5L10 7.5l5 5"/>');
    add("chevron-down", "universal", '<path d="M5 7.5l5 5 5-5"/>');
    add("chevron-left", "universal", '<path d="M12.5 5L7.5 10l5 5"/>');
    add("chevron-right", "universal", '<path d="M7.5 5l5 5-5 5"/>');
    add("arrow-left", "universal", '<path d="M16 10H4m0 0l4-4m-4 4l4 4"/>');
    add("arrow-right", "universal", '<path d="M4 10h12m0 0l-4-4m4 4l-4 4"/>');
    add("arrow-up", "universal", '<path d="M10 16V4m0 0L6 8m4-4l4 4"/>');
    add("arrow-down", "universal", '<path d="M10 4v12m0 0l-4-4m4 4l4-4"/>');
    add("refresh", "universal", '<path d="M16.5 7A6.5 6.5 0 1 0 17 12m0-5V3.5m0 3.5H13.5"/>');
    add("reset", "universal", '<path d="M6 5.5H3.5V3M3.5 5.5A7 7 0 1 1 3.5 14"/>');
    add("undo", "universal", '<path d="M7 6H3.5V2.5m0 3.5A6.5 6.5 0 1 1 5 13.5"/>');
    add("redo", "universal", '<path d="M13 6h3.5V2.5m0 3.5A6.5 6.5 0 1 0 15 13.5"/>');
    add("edit", "universal", '<path d="M3.5 14v2.5H6l9.5-9.5-2.5-2.5zM11.5 5.5l2.5 2.5"/>');
    add("trash", "universal", '<path d="M4 5.5h12M7.5 5.5v-2h5v2M5.5 5.5l.75 11h7.5l.75-11M8.5 8.5v5M11.5 8.5v5"/>');
    add("copy", "universal", '<rect x="6.5" y="6.5" width="9" height="9" rx="1.5"/><path d="M13.5 6.5V4.5H4.5v9h2"/>');
    add("duplicate", "universal", '<rect x="7" y="7" width="8.5" height="8.5" rx="1.5"/><path d="M13 7V4.5H4.5V13H7m4.25-3v3.5m-1.75-1.75H13"/>');
    add("save", "universal", '<path d="M4 3.5h9.5l3 3V16.5H4zM7 3.5v4.5h6V3.5M7 16.5v-4.5h6v4.5"/>');
    add("import", "universal", '<path d="M10 3.5v9m0 0L6.5 9m3.5 3.5L13.5 9M4 14.5v2h12v-2"/>');
    add("export", "universal", '<path d="M10 12.5v-9m0 0L6.5 7m3.5-3.5L13.5 7M4 14.5v2h12v-2"/>');
    add("upload", "universal", '<path d="M4 14.5v2h12v-2M10 14V4.5m0 0L6.5 8M10 4.5l3.5 3.5"/>');
    add("download", "universal", '<path d="M4 14.5v2h12v-2M10 4.5v9.5m0 0l-3.5-3.5M10 14l3.5-3.5"/>');
    add("browse", "universal", '<path d="M3.5 5.5h5l1.5 2h6.5v8.5h-13zM3.5 7.5h13"/>');
    add("external-link", "universal", '<path d="M9 5H4.5v10.5H15V11M11 4h5v5M16 4l-7 7"/>');
    add("play", "universal", '<path d="M7 4.5l8 5.5-8 5.5z"/>');
    add("pause", "universal", '<path d="M6.5 4.5v11M13.5 4.5v11"/>');
    add("stop", "universal", '<rect x="5" y="5" width="10" height="10" rx="1.5"/>');
    add("eye", "universal", '<path d="M2.5 10s2.5-4.5 7.5-4.5 7.5 4.5 7.5 4.5-2.5 4.5-7.5 4.5S2.5 10 2.5 10z"/><circle cx="10" cy="10" r="2.25"/>');
    add("eye-off", "universal", '<path d="M3 3l14 14M7.2 6.3C8.1 5.8 9 5.5 10 5.5c5 0 7.5 4.5 7.5 4.5a10.5 10.5 0 0 1-2.2 2.7M11.8 14.3c-.6.1-1.2.2-1.8.2-5 0-7.5-4.5-7.5-4.5a11 11 0 0 1 2.5-3.1"/>');
    add("lock", "universal", '<rect x="4.5" y="8.5" width="11" height="8" rx="1.5"/><path d="M7 8.5V6a3 3 0 0 1 6 0v2.5M10 11.5v2"/>');
    add("unlock", "universal", '<rect x="4.5" y="8.5" width="11" height="8" rx="1.5"/><path d="M7 8.5V6a3 3 0 0 1 5.6-1.5M10 11.5v2"/>');
    add("pin", "universal", '<path d="M7 3.5h6l-.75 4 2.25 2.25v1H5.5v-1L7.75 7.5zM10 10.75V17"/>');
    add("unpin", "universal", '<path d="M4 3l12 14M8 3.5h5l-.75 4 2.25 2.25v1h-3M8.5 10.75h-3v-1l1.25-1.25M10 12.25V17"/>');
    add("favorite", "universal", '<path d="M10 3l2.25 4.5 5 .75-3.6 3.5.85 5-4.5-2.4L5.5 16.75l.85-5L2.75 8.25l5-.75z"/>');
    add("favorite-on", "universal", '<path d="M10 3l2.25 4.5 5 .75-3.6 3.5.85 5-4.5-2.4L5.5 16.75l.85-5L2.75 8.25l5-.75z" fill="currentColor"/>', true);
    add("grid", "universal", '<rect x="3.5" y="3.5" width="5" height="5" rx="1.25"/><rect x="11.5" y="3.5" width="5" height="5" rx="1.25"/><rect x="3.5" y="11.5" width="5" height="5" rx="1.25"/><rect x="11.5" y="11.5" width="5" height="5" rx="1.25"/>');
    add("list", "universal", '<path d="M7 5h9.5M7 10h9.5M7 15h9.5"/><circle cx="4" cy="5" r=".75" fill="currentColor" stroke="none"/><circle cx="4" cy="10" r=".75" fill="currentColor" stroke="none"/><circle cx="4" cy="15" r=".75" fill="currentColor" stroke="none"/>', true);
    add("info", "universal", '<circle cx="10" cy="10" r="7"/><path d="M10 9v4M10 6.5h.01"/>');
    add("help", "universal", '<circle cx="10" cy="10" r="7"/><path d="M7.8 7.5a2.4 2.4 0 1 1 3.1 2.3c-.9.35-.9 1.2-.9 1.7M10 14h.01"/>');

    // --- Navigation Destinations ---
    add("nav-templates", "navigation", '<rect x="3.5" y="4" width="13" height="12" rx="2"/><path d="M3.5 8.5h13M8.5 8.5v7.5"/>');
    add("nav-tools", "navigation", '<path d="M12.5 4.25a4 4 0 0 0-4.8 5L3.8 13.2a2.1 2.1 0 0 0 3 3l3.95-3.9a4 4 0 0 0 5-4.8l-2.5 2.25-3-3z"/>');
    add("nav-effects", "navigation", '<path d="M10 2.5L12 7l4.5 1.5L13 12l1 4.5L10 14l-4 2.5 1-4.5-3.5-3.5L8 7z"/>');
    add("nav-text", "navigation", '<path d="M4 5V3.5h12V5M7.5 16.5h5M10 3.5v13M14.5 9l2 1.5-2 1.5"/>');
    add("nav-easing", "navigation", '<path d="M3.5 16.5h13M3.5 16.5c3.5 0 3-11 7-11 3 0 2.5 5 5 5"/>');
    add("nav-colorflow", "navigation", '<path d="M10 3c3.5 3.5 5.5 6 5.5 8.5a5.5 5.5 0 0 1-11 0C4.5 9 6.5 6.5 10 3z"/>');
    add("nav-settings", "navigation", '<circle cx="10" cy="10" r="2.5"/><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5 5l1.4 1.4M13.6 13.6l1.4 1.4M15 5l-1.4 1.4M6.4 13.6l-1.4 1.4"/>');

    // --- Library & Assets ---
    add("library-composition", "library", '<rect x="3" y="4" width="14" height="10" rx="1.5"/><path d="M7 17h6M10 14v3M6 7h8v4H6z"/>');
    add("library-image", "library", '<rect x="3.5" y="3.5" width="13" height="13" rx="2"/><circle cx="7.5" cy="7.5" r="1.25"/><path d="M4.5 14l3.5-3.5 2.5 2.5 2-2 3 3"/>');
    add("library-icon", "library", '<path d="M6 3.5a2.5 2.5 0 1 0 0 5h8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0-2.5 2.5v8a2.5 2.5 0 1 0 2.5-2.5H6A2.5 2.5 0 1 0 8.5 14V6A2.5 2.5 0 0 0 6 3.5z"/>');
    add("library-layer", "library", '<path d="M3.5 6.5L10 3.5l6.5 3-6.5 3zM3.5 10l6.5 3 6.5-3M3.5 13.5l6.5 3 6.5-3"/>');
    add("library-text", "library", '<path d="M4 6V4h12v2M7 16h6M10 4v12"/>');
    add("library-footage", "library", '<rect x="3" y="5" width="10.5" height="10" rx="1.5"/><path d="M13.5 8l3.5-2v8l-3.5-2zM6 8h4.5M6 11h3"/>');
    add("library-effect", "library", '<path d="M11 3.5L5 10h4l-1 6.5 7-8h-4zM4 4.5h3M3.5 6h2"/>');
    add("library-folder", "library", '<path d="M3.5 5.5h5l1.5 2h6.5v8.5h-13z"/>');
    add("library-folder-open", "library", '<path d="M3.5 7.5V5.5h5l1.5 2h6.5l-2 8.5h-11zM5.5 10h8"/>');
    add("library-category-add", "library", '<path d="M3.5 5.5h5l1.5 2h6.5v8.5h-13zM12.5 10.5v4M10.5 12.5h4"/>');
    add("library-move", "library", '<path d="M3.5 5.5h5l1.5 2h6.5v7.5h-13zM6.5 11.5h6m0 0l-2-2m2 2l-2 2"/>');
    add("library-rename", "library", '<path d="M3.5 5.5h5l1.5 2h6.5v8.5h-13zM7 13.5l5-5 2 2-5 5H7z"/>');
    add("library-apply", "library", '<rect x="3.5" y="4" width="9" height="12" rx="1.5"/><path d="M10 10h6.5m0 0l-2.5-2.5m2.5 2.5l-2.5 2.5"/>');
    add("library-bulk-select", "library", '<rect x="3.5" y="3.5" width="5" height="5" rx="1"/><rect x="11.5" y="3.5" width="5" height="5" rx="1"/><rect x="3.5" y="11.5" width="5" height="5" rx="1"/><path d="M11.5 13.5l1.5 1.5 3-3.5"/>');
    add("library-card-size", "library", '<rect x="3" y="5" width="6" height="10" rx="1"/><rect x="11.5" y="3.5" width="5.5" height="13" rx="1"/>');
    add("library-density", "library", '<path d="M4 5h12M4 8.5h12M4 12h12M4 15.5h12"/>');
    add("library-path", "library", '<path d="M3.5 6.5h5l1.5 2h6.5v7.5h-13zM6.5 4h7.5M11.5 2.5L13.5 4l-2 1.5"/>');
    add("library-thumbnail", "library", '<rect x="3.5" y="4.5" width="13" height="11" rx="1.5"/><path d="M5.5 13l3-3 2 2 2.5-2.5 2 2.5"/><circle cx="7" cy="8" r="1"/>');
    add("library-preview", "library", '<rect x="3.5" y="4" width="13" height="12" rx="1.5"/><path d="M8.25 7l5 3-5 3z"/>');
    add("library-missing-preview", "library", '<rect x="3.5" y="4" width="13" height="12" rx="1.5"/><path d="M5 5.5l10 9M8.5 7.5l4.5 2.5-2 1.2"/>');

    // --- Toolkit & Transform ---
    add("anchor-top-left", "toolkit", '<rect x="4" y="4" width="12" height="12" rx="1.5"/><circle cx="6.5" cy="6.5" r="1.5" fill="currentColor" stroke="none"/>', true);
    add("anchor-top", "toolkit", '<rect x="4" y="4" width="12" height="12" rx="1.5"/><circle cx="10" cy="6.5" r="1.5" fill="currentColor" stroke="none"/>', true);
    add("anchor-top-right", "toolkit", '<rect x="4" y="4" width="12" height="12" rx="1.5"/><circle cx="13.5" cy="6.5" r="1.5" fill="currentColor" stroke="none"/>', true);
    add("anchor-left", "toolkit", '<rect x="4" y="4" width="12" height="12" rx="1.5"/><circle cx="6.5" cy="10" r="1.5" fill="currentColor" stroke="none"/>', true);
    add("anchor-center", "toolkit", '<rect x="4" y="4" width="12" height="12" rx="1.5"/><circle cx="10" cy="10" r="1.5" fill="currentColor" stroke="none"/>', true);
    add("anchor-right", "toolkit", '<rect x="4" y="4" width="12" height="12" rx="1.5"/><circle cx="13.5" cy="10" r="1.5" fill="currentColor" stroke="none"/>', true);
    add("anchor-bottom-left", "toolkit", '<rect x="4" y="4" width="12" height="12" rx="1.5"/><circle cx="6.5" cy="13.5" r="1.5" fill="currentColor" stroke="none"/>', true);
    add("anchor-bottom", "toolkit", '<rect x="4" y="4" width="12" height="12" rx="1.5"/><circle cx="10" cy="13.5" r="1.5" fill="currentColor" stroke="none"/>', true);
    add("anchor-bottom-right", "toolkit", '<rect x="4" y="4" width="12" height="12" rx="1.5"/><circle cx="13.5" cy="13.5" r="1.5" fill="currentColor" stroke="none"/>', true);

    add("create-null", "toolkit", '<rect x="4" y="4" width="12" height="12" rx="1.5"/><path d="M10 6v8M6 10h8"/>');
    add("create-adjustment", "toolkit", '<rect x="3.5" y="5" width="13" height="10" rx="1.5"/><path d="M10 5v10M6 8.5h2M12 11.5h2"/>');
    add("create-camera", "toolkit", '<rect x="3" y="6" width="10.5" height="8" rx="1.5"/><path d="M13.5 8.5l3.5-2v7l-3.5-2zM6 6l1-2h3l1 2"/>');
    add("create-solid", "toolkit", '<rect x="3.5" y="3.5" width="13" height="13" rx="1.5"/><path d="M6 6h8v8H6z" fill="currentColor" stroke="none"/>', true);
    add("create-text", "toolkit", '<path d="M3.5 6V4h13v2M7 16h6M10 4v12M14 13h3M15.5 11.5v3"/>');
    add("precompose", "toolkit", '<rect x="3" y="5" width="9" height="10" rx="1.25"/><rect x="8" y="3" width="9" height="10" rx="1.25"/><path d="M11 8h3M12.5 6.5v3"/>');
    add("multi-precompose", "toolkit", '<rect x="3" y="7" width="8" height="9" rx="1"/><rect x="6" y="4" width="8" height="9" rx="1"/><rect x="9" y="2" width="8" height="9" rx="1"/>');
    add("unprecompose", "toolkit", '<rect x="3" y="5" width="9" height="10" rx="1"/><rect x="8" y="3" width="9" height="10" rx="1"/><path d="M14 8h-3m0 0l1.5-1.5M11 8l1.5 1.5"/>');
    add("true-duplicate", "toolkit", '<rect x="4" y="6" width="9" height="10" rx="1"/><rect x="7" y="3" width="9" height="10" rx="1"/><path d="M10 8h3M11.5 6.5v3"/>');
    add("align-left", "toolkit", '<path d="M4 3.5v13M7 6h8v3H7zM7 11h5v3H7z"/>');
    add("align-center", "toolkit", '<path d="M10 3.5v13M5 6h10v3H5zM7 11h6v3H7z"/>');
    add("align-right", "toolkit", '<path d="M16 3.5v13M5 6h8v3H5zM8 11h5v3H8z"/>');
    add("align-top", "toolkit", '<path d="M3.5 4h13M6 7v8h3V7zM11 7v5h3V7z"/>');
    add("align-middle", "toolkit", '<path d="M3.5 10h13M6 5v10h3V5zM11 7v6h3V7z"/>');
    add("align-bottom", "toolkit", '<path d="M3.5 16h13M6 5v8h3V5zM11 8v5h3V8z"/>');
    add("distribute-horizontal", "toolkit", '<path d="M3.5 4v12M16.5 4v12M6 7h3v6H6zM11 7h3v6h-3z"/>');
    add("distribute-vertical", "toolkit", '<path d="M4 3.5h12M4 16.5h12M7 6h6v3H7zM7 11h6v3H7z"/>');
    add("guide-add", "toolkit", '<path d="M4 3.5v13M3 7h14M12.5 10v5M10 12.5h5"/>');
    add("guide-clear", "toolkit", '<path d="M4 3.5v13M3 7h14M10.5 11l4 4m0-4l-4 4"/>');
    add("organize-project", "toolkit", '<path d="M3 6h5l1.5 2H17v8H3zM6 11h8M6 13.5h5M14.5 3.5v3m-1.5-1.5h3"/>');
    add("expression-add", "toolkit", '<path d="M4 5.5h4l-2 9h4M12 8l4 4m0-4l-4 4"/>');
    add("expression-remove", "toolkit", '<path d="M4 5.5h4l-2 9h4M11 7l6 6M17 7l-6 6"/>');
    add("effects-toggle", "toolkit", '<path d="M10 3.5l1.4 4.1 4.1 1.4-4.1 1.4-1.4 4.1-1.4-4.1L4.5 9l4.1-1.4zM15 14l2 2m0-2l-2 2"/>');
    add("paste-image", "toolkit", '<path d="M7 5h6M8 3.5h4v3H8zM5 5h-1v11h12V5h-1M6.5 14l2.5-3 2 2 1.5-2 2 3"/>');
    add("crop", "toolkit", '<path d="M5 3.5v11h11M3.5 5H14v11M8 8h4v4H8z"/>');
    add("sequence-up", "toolkit", '<path d="M4 15h3v-3H4zM8.5 11.5h3v-3h-3zM13 8h3V5h-3zM10 16V4m0 0L7.5 6.5M10 4l2.5 2.5"/>');
    add("sequence-down", "toolkit", '<path d="M4 5h3v3H4zM8.5 8.5h3v3h-3zM13 12h3v3h-3zM10 4v12m0 0l-2.5-2.5M10 16l2.5-2.5"/>');
    add("sequence-random", "toolkit", '<path d="M3.5 6h2.5c4 0 4 8 8 8h2.5M14 11.5l2.5 2.5-2.5 2.5M3.5 14H6c1.4 0 2.4-1 3.3-2.2M11 8.2C11.8 7 12.7 6 14 6h2.5M14 3.5L16.5 6 14 8.5"/>');
    add("sequence-from-center", "toolkit", '<path d="M10 4v12M8 10H3m0 0l2-2m-2 2l2 2M12 10h5m0 0l-2-2m2 2l-2 2"/>');
    add("sequence-to-center", "toolkit", '<path d="M10 4v12M3 10h5m-2-2l2 2-2 2M17 10h-5m2-2l-2 2 2 2"/>');
    add("bounce", "toolkit", '<path d="M3.5 15.5h13M4 13c1.5 0 2-8 5-8 2.5 0 2.5 7 4.5 7 1.5 0 1.5-3 3-3"/><circle cx="4" cy="13" r=".75" fill="currentColor" stroke="none"/>', true);

    // --- Preset Actions ---
    add("preset-stack", "preset", '<rect x="4" y="4" width="10" height="9" rx="1.5"/><path d="M6 16h10V7M7 7h4M7 10h3"/>');
    add("preset-save", "preset", '<rect x="4" y="3.5" width="12" height="13" rx="1.5"/><path d="M7 3.5v5h6v-4M7 16.5v-5h6v5M14.5 8.5h3M16 7v3"/>');
    add("preset-apply", "preset", '<rect x="3.5" y="4" width="9" height="12" rx="1.5"/><path d="M9.5 7.5L12 10l-2.5 2.5M12 10h5"/>');
    add("preset-import-ffx", "preset", '<path d="M4 4h8l3 3v9H4zM12 4v3h3M9.5 8v5m0 0L7 10.5M9.5 13l2.5-2.5"/>');
    add("preset-reset-text", "preset", '<path d="M4 6V4h10v2M7 14h4M9 4v10M15 10a3 3 0 1 1-1 5.25M14 13h-2v-2"/>');
    add("preset-category", "preset", '<path d="M3.5 6h5l1.5 2h6.5v7.5h-13zM7 11h6M7 13.5h4"/>');
    add("preset-favorite-filter", "preset", '<path d="M3 5h14l-5.5 6v4l-3 1.5V11zM10 5.5l.75 1.5 1.75.25-1.25 1.2.3 1.75-1.55-.8-1.55.8.3-1.75-1.25-1.2L9.25 7z"/>');
    add("preset-bulk-import", "preset", '<path d="M3 5h6v10H3zM11 5h6v10h-6zM6 7v5m0 0L4.5 10.5M6 12l1.5-1.5M14 7v5m0 0l-1.5-1.5M14 12l1.5-1.5"/>');

    // --- Easing Curve Studio ---
    add("easing-curve", "easing", '<path d="M3.5 16.5V3.5M3.5 16.5h13M4.5 14.5c3.5 0 3-9 7.5-9 2.5 0 2 4 4.5 4"/>');
    add("easing-handle-in", "easing", '<path d="M4 15l5-5M4 15h5M4 15v-5"/><circle cx="9" cy="10" r="1.5"/>');
    add("easing-handle-out", "easing", '<path d="M16 5l-5 5M16 5h-5M16 5v5"/><circle cx="11" cy="10" r="1.5"/>');
    add("easing-direction", "easing", '<path d="M3.5 14c3 0 4-8 8-8 2 0 2.5 2 4.5 2M13.5 4.5L16 8l-3.5 2"/>');
    add("easing-core", "easing", '<circle cx="10" cy="10" r="6.5"/><path d="M6 13c2 0 2-6 5-6 1.5 0 2 1.5 3 1.5"/>');
    add("easing-user", "easing", '<circle cx="10" cy="7" r="2.5"/><path d="M5 16c.5-3 2-5 5-5s4.5 2 5 5M13.5 4.5l2-1.5"/>');
    add("easing-recent", "easing", '<circle cx="10" cy="10" r="6.5"/><path d="M10 6v4l3 2M4 5v3h3"/>');
    add("easing-save", "easing", '<path d="M4 3.5h9l3 3V16H4zM7 3.5v5h6v-4M6.5 14c1.5 0 1.5-3 3.5-3 1.5 0 1.5 2 3.5 2"/>');
    add("easing-apply", "easing", '<path d="M3.5 15.5h8M4 14c2.5 0 2-7 5.5-7 2 0 2 2.5 3.5 2.5M13 13h4m0 0l-2-2m2 2l-2 2"/>');
    add("easing-import", "easing", '<path d="M4 4h8l3 3v9H4zM12 4v3h3M6 13c1.5 0 1.5-4 4-4 1.5 0 1.5 2 3 2"/>');
    add("easing-reset", "easing", '<path d="M5.5 6H3V3.5M3.5 6A6.5 6.5 0 1 1 4 14M6 13c2 0 2-5 5-5 1.5 0 2 1.5 3 1.5"/>');

    // --- ColorFlow Workshop ---
    add("colorflow-palette", "colorflow", '<path d="M10 3.5a6.5 6.5 0 0 0 0 13h1.2a1.3 1.3 0 0 0 .4-2.55 1.5 1.5 0 0 1 .4-2.95h1.5A3.5 3.5 0 0 0 17 7.5c0-2.2-3.1-4-7-4z"/><circle cx="6.5" cy="8" r=".75" fill="currentColor" stroke="none"/><circle cx="9" cy="6" r=".75" fill="currentColor" stroke="none"/><circle cx="12" cy="6.5" r=".75" fill="currentColor" stroke="none"/>', true);
    add("colorflow-swatch", "colorflow", '<rect x="3.5" y="3.5" width="13" height="13" rx="2"/><path d="M6 6h8v8H6z" fill="currentColor" stroke="none"/>', true);
    add("colorflow-picker", "colorflow", '<path d="M12.5 4.5l3 3-7.5 7.5H5v-3zM11 6l3 3M4 16h5"/>');
    add("colorflow-fill", "colorflow", '<path d="M6 4l8 8-5 5-6-6zM8 6l4 4M13 15h4"/><path d="M15 12.5c1 1.2 1.5 2 1.5 2.6a1.5 1.5 0 0 1-3 0c0-.6.5-1.4 1.5-2.6z"/>');
    add("colorflow-stroke", "colorflow", '<rect x="4" y="4" width="12" height="12" rx="2"/><rect x="7" y="7" width="6" height="6" rx="1"/>');
    add("colorflow-both", "colorflow", '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/><path d="M7.5 7.5h9v9h-9zM10 10h4v4h-4z"/>');
    add("colorflow-eyedropper", "colorflow", '<path d="M12 4l4 4-7.5 7.5H5v-3zM10.5 5.5l4 4M5 15.5L3.5 17"/>');
    add("colorflow-hue", "colorflow", '<circle cx="10" cy="10" r="6.5"/><path d="M10 3.5v13M3.5 10h13M5.5 5.5l9 9M14.5 5.5l-9 9"/>');
    add("colorflow-edit-swatch", "colorflow", '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/><path d="M9 15.5l1-3.5 4.5-4.5 2 2L12 14z"/>');
    add("colorflow-apply", "colorflow", '<path d="M7 4c3 3.2 4.5 5 4.5 7a4.5 4.5 0 0 1-9 0c0-2 1.5-3.8 4.5-7zM12 13h5m0 0l-2-2m2 2l-2 2"/>');

    // --- Settings Groups ---
    add("settings-library", "settings", '<path d="M3.5 5.5h5l1.5 2h6.5v8.5h-13zM6.5 10.5h7"/>');
    add("settings-preview", "settings", '<rect x="3.5" y="4" width="13" height="12" rx="1.5"/><path d="M8.5 7.5l4.5 2.5-4.5 2.5z"/>');
    add("settings-interface", "settings", '<rect x="3.5" y="3.5" width="13" height="13" rx="1.5"/><path d="M3.5 7.5h13M8.5 7.5v9"/>');
    add("settings-performance", "settings", '<path d="M10.5 3.5L5 10h4l-.5 6.5 6.5-8h-4zM4 4h3M3 6h2"/>');
    add("settings-toolkit", "settings", '<path d="M12.5 4a4 4 0 0 0-4.75 5L4 12.75a2.3 2.3 0 0 0 3.25 3.25L11 12.25a4 4 0 0 0 5-4.75L13.5 10l-3-3z"/>');
    add("settings-appearance", "settings", '<path d="M10 3.5a6.5 6.5 0 1 0 0 13h1a1.25 1.25 0 0 0 .3-2.45A1.5 1.5 0 0 1 12 11h1.5A3.5 3.5 0 0 0 17 7.5c0-2.2-3.1-4-7-4z"/>');
    add("settings-backup", "settings", '<path d="M4 3.5h9l3 3V16.5H4zM7 3.5v4h6V4M7 16.5v-4.5h6v4.5"/>');
    add("settings-data", "settings", '<ellipse cx="10" cy="5" rx="6.5" ry="2.25"/><path d="M3.5 5v5c0 1.2 2.9 2.25 6.5 2.25s6.5-1.05 6.5-2.25V5M3.5 10v5c0 1.2 2.9 2.25 6.5 2.25s6.5-1.05 6.5-2.25v-5"/>');
    add("settings-about", "settings", '<circle cx="10" cy="10" r="6.5"/><path d="M10 9v4M10 6.5h.01"/>');

    // --- Status & Feedback ---
    add("status-success", "status", '<circle cx="10" cy="10" r="7"/><path d="M6.5 10.25l2.25 2.25 4.75-5"/>');
    add("status-warning", "status", '<path d="M10 3.25l7 13H3zM10 7.5v4M10 14h.01"/>');
    add("status-error", "status", '<circle cx="10" cy="10" r="7"/><path d="M7 7l6 6m0-6l-6 6"/>');
    add("status-info", "status", '<circle cx="10" cy="10" r="7"/><path d="M10 9.5v4M10 6.5h.01"/>');
    add("status-loading", "status", '<path d="M10 3a7 7 0 0 1 7 7M10 17a7 7 0 0 1-7-7"/><circle cx="10" cy="3" r="1" fill="currentColor" stroke="none"/>', true);
    add("status-offline", "status", '<path d="M3 5l14 10M5 9a8 8 0 0 1 8-2M7 12a4.5 4.5 0 0 1 4.5-.75M10 15.5h.01"/>');
    add("status-degraded", "status", '<path d="M3.5 12a3.5 3.5 0 0 1 3-3.45A5 5 0 0 1 16 10a3 3 0 0 1-.5 6H6.75M10 11v2.5M10 15.5h.01"/>');
    add("status-connected", "status", '<path d="M6 8.5l-2 2a3 3 0 0 0 4.25 4.25l2-2M14 11.5l2-2a3 3 0 0 0-4.25-4.25l-2 2M7.5 12.5l5-5"/>');
    add("status-busy", "status", '<circle cx="10" cy="10" r="6.5"/><path d="M10 6v4l2.75 1.75M4 3.5v3h3"/>');
    add("feedback-toast", "feedback", '<path d="M3.5 5h13v9H9l-3.5 3v-3h-2zM6.5 8h7M6.5 11h4"/>');
    add("feedback-notification", "feedback", '<path d="M5 13.5h10l-1.5-2V8a3.5 3.5 0 0 0-7 0v3.5zM8.5 16h3"/>');
    add("feedback-confirm", "feedback", '<path d="M4 4.5h12v11H4zM6.5 10l2 2 5-5"/>');
    add("feedback-retry", "feedback", '<path d="M5.5 6H3V3.5M3.5 6A6.5 6.5 0 1 1 4 14M10 7v3l2 1.5"/>');
    add("feedback-unavailable", "feedback", '<path d="M3.5 13a3.5 3.5 0 0 1 3-3.45A5 5 0 0 1 16 11a3 3 0 0 1-1 5H7M5 4l10 12"/>');
    add("feedback-unreadable", "feedback", '<path d="M4 3.5h8l3 3V16H4zM12 3.5v3h3M6.5 9h6M6.5 12h3M5 4l10 12"/>');
    add("feedback-bridge-error", "feedback", '<path d="M6 8.5l-2 2a3 3 0 0 0 4.25 4.25l1.25-1.25M14 11.5l2-2a3 3 0 0 0-4.25-4.25L10.5 6.5M4 4l12 12"/>');

    // --- Empty-State Vector Artwork (48px Grid) ---
    art("empty-library", '<rect x="8" y="12" width="32" height="26" rx="4" opacity="0.3"/><path d="M14 20h20M14 26h14M14 32h8"/><circle cx="36" cy="12" r="6" fill="var(--cs-accent-subtle)" stroke="var(--cs-accent)" stroke-width="2"/><path d="M36 9v6M33 12h6"/>');
    art("empty-search", '<circle cx="21" cy="21" r="11"/><path d="M29 29l10 10M16 21h10"/><path d="M10 9l4 4M34 9l-4 4"/>');
    art("empty-presets", '<rect x="10" y="11" width="22" height="20" rx="3"/><path d="M16 17h10M16 22h7M16 27h12M17 38h21V17"/><path d="M36 8v8M32 12h8"/>');
    art("empty-colorflow", '<path d="M24 7c9 9 13 15 13 21a13 13 0 0 1-26 0c0-6 4-12 13-21z"/><path d="M15 30c5 3 13 3 18 0M20 17h8"/>');
    art("empty-easing", '<path d="M8 39V9M8 39h32M10 35c9 0 8-21 19-21 6 0 5 9 11 9"/><circle cx="17" cy="28" r="2.5" fill="currentColor" stroke="none"/><circle cx="31" cy="14" r="2.5" fill="currentColor" stroke="none"/>');
    art("empty-error", '<path d="M24 7l17 32H7zM24 17v10M24 33h.01"/><path d="M12 42h24"/>');
    art("empty-offline", '<path d="M8 17l32 23M12 26a18 18 0 0 1 19-6M17 33a10 10 0 0 1 10-2M24 40h.01"/><path d="M7 9l34 25"/>');

    function escapeAttr(value) {
        return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function normalizeSize(value, fallback) {
        var size = Number(value);
        return isFinite(size) && size > 0 && size <= 512 ? size : fallback;
    }

    function accessibilityAttributes(options) {
        var label = options && options.label;
        if (label) return ' role="img" aria-label="' + escapeAttr(label) + '"';
        return ' aria-hidden="true" focusable="false"';
    }

    function svgClass(base, options) {
        return base + (options && options.className ? " " + escapeAttr(options.className) : "");
    }

    function render(name, options) {
        var definition = definitions[name];
        if (!definition) throw new Error("Unknown CompSaver icon: " + name);
        options = options || {};
        var size = normalizeSize(options.size, GRID);
        return '<svg class="' + svgClass("cs-icon cs-icon--" + name, options) + '" width="' + size + '" height="' + size + '" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" xmlns="http://www.w3.org/2000/svg"' + accessibilityAttributes(options) + '>' + definition.body + '</svg>';
    }

    function renderArt(name, options) {
        var definition = emptyArt[name];
        if (!definition) throw new Error("Unknown CompSaver empty-state art: " + name);
        options = options || {};
        var size = normalizeSize(options.size, 48);
        return '<svg class="' + svgClass("cs-empty-art cs-empty-art--" + name, options) + '" width="' + size + '" height="' + size + '" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" xmlns="http://www.w3.org/2000/svg"' + accessibilityAttributes(options) + '>' + definition.body + '</svg>';
    }

    // --- Modern Brand Mark & Logo Redesign ---
    function mark(options) {
        options = options || {};
        var size = normalizeSize(options.size, 24);
        var body = '<path d="M5.25 4.25h8.5a3 3 0 0 1 3 3v5.5a3 3 0 0 1-3 3H9.5l-2.25 2v-2H5.25a3 3 0 0 1-3-3v-5.5a3 3 0 0 1 3-3z"/>' +
            '<path d="M8.25 7.25h6.5a3 3 0 0 1 3 3v5.5h-3.5l-2 2-2-2h-2a3 3 0 0 1-3-3v-1.5"/>' +
            '<path d="M8 8.5h4M8 11.5h2.5"/>';
        return '<svg class="' + svgClass("cs-brand-mark", options) + '" width="' + size + '" height="' + size + '" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"' + accessibilityAttributes(options) + '>' + body + '</svg>';
    }

    function wordmark(options) {
        options = options || {};
        var width = normalizeSize(options.width, 92);
        var height = normalizeSize(options.height, 20);
        return '<svg class="' + svgClass("cs-brand-wordmark", options) + '" width="' + width + '" height="' + height + '" viewBox="0 0 92 20" xmlns="http://www.w3.org/2000/svg"' + accessibilityAttributes(options) + '><text x="1" y="14" fill="currentColor" font-family="Segoe UI,Arial,sans-serif" font-size="13" font-weight="600" letter-spacing=".15">Comp<tspan font-weight="700">Saver</tspan></text></svg>';
    }

    function brand(options) {
        options = options || {};
        var label = options.label || "CompSaver";
        return '<span class="cs-brand" role="img" aria-label="' + escapeAttr(label) + '">' + mark({ size: options.markSize || 24 }) + wordmark({ width: options.wordmarkWidth || 92, height: options.wordmarkHeight || 20 }) + '</span>';
    }

    function get(name) {
        var definition = definitions[name];
        return definition ? { name: definition.name, family: definition.family, body: definition.body, filledState: definition.filledState } : null;
    }

    function getArt(name) {
        var definition = emptyArt[name];
        return definition ? { name: definition.name, body: definition.body } : null;
    }

    function inventory() {
        var result = {};
        Object.keys(families).forEach(function (family) { result[family] = families[family].slice(); });
        return result;
    }

    function names() { return Object.keys(definitions); }
    function artNames() { return Object.keys(emptyArt); }

    return {
        version: "foldframe-1",
        design: { grid: GRID, strokeWidth: STROKE, strokeLinecap: "round", strokeLinejoin: "round", minimumInteriorGap: 2, metaphor: "geometric-rounded-line" },
        render: render,
        renderArt: renderArt,
        mark: mark,
        wordmark: wordmark,
        brand: brand,
        get: get,
        getArt: getArt,
        names: names,
        artNames: artNames,
        inventory: inventory
    };
}());

if (typeof module !== "undefined" && module.exports) {
    module.exports = CompSaverIcons;
}
