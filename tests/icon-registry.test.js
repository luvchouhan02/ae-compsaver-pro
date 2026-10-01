"use strict";

const Icons = require("../js/ui/icons");

const REQUIRED_FAMILIES = {
    navigation: ["nav-templates", "nav-tools", "nav-effects", "nav-text", "nav-easing", "nav-colorflow", "nav-settings"],
    library: ["library-composition", "library-image", "library-icon", "library-layer", "library-text", "library-footage", "library-effect", "library-folder", "library-apply", "library-bulk-select", "library-preview", "library-missing-preview"],
    toolkit: ["anchor-top-left", "anchor-top", "anchor-top-right", "anchor-left", "anchor-center", "anchor-right", "anchor-bottom-left", "anchor-bottom", "anchor-bottom-right", "create-null", "create-adjustment", "create-camera", "create-solid", "create-text", "precompose", "multi-precompose", "unprecompose", "true-duplicate", "align-left", "align-center", "align-right", "align-top", "align-middle", "align-bottom", "distribute-horizontal", "distribute-vertical", "guide-add", "guide-clear", "organize-project", "expression-add", "expression-remove", "effects-toggle", "paste-image", "crop", "sequence-up", "sequence-down", "sequence-random", "sequence-from-center", "sequence-to-center", "bounce"],
    preset: ["preset-stack", "preset-save", "preset-apply", "preset-import-ffx", "preset-reset-text", "preset-category", "preset-favorite-filter", "preset-bulk-import"],
    easing: ["easing-curve", "easing-handle-in", "easing-handle-out", "easing-direction", "easing-core", "easing-user", "easing-recent", "easing-save", "easing-apply", "easing-import", "easing-reset"],
    colorflow: ["colorflow-palette", "colorflow-swatch", "colorflow-picker", "colorflow-fill", "colorflow-stroke", "colorflow-both", "colorflow-eyedropper", "colorflow-hue", "colorflow-edit-swatch", "colorflow-apply"],
    settings: ["settings-library", "settings-preview", "settings-interface", "settings-performance", "settings-toolkit", "settings-appearance", "settings-backup", "settings-data", "settings-about"],
    status: ["status-success", "status-warning", "status-error", "status-info", "status-loading", "status-offline", "status-degraded", "status-connected", "status-busy"],
    feedback: ["feedback-toast", "feedback-notification", "feedback-confirm", "feedback-retry", "feedback-unavailable", "feedback-unreadable", "feedback-bridge-error"]
};

describe("Foldframe brand", () => {
    test("uses a new currentColor mark and CompSaver-only wordmark", () => {
        const mark = Icons.mark({ label: "Foldframe mark" });
        const wordmark = Icons.wordmark({ label: "CompSaver" });
        expect(mark).toContain('viewBox="0 0 20 20"');
        expect(mark).toContain('stroke="currentColor"');
        expect(mark).toContain('aria-label="Foldframe mark"');
        expect(wordmark).toContain("Comp");
        expect(wordmark).toContain("Saver");
        expect((mark + wordmark).toLowerCase()).not.toMatch(/flask|lab\.pro|motion panel/);
    });

    test("brand helper exposes one programmatic product name", () => {
        const brand = Icons.brand();
        expect(brand).toContain('role="img"');
        expect(brand).toContain('aria-label="CompSaver"');
        expect(brand.match(/aria-hidden="true"/g)).toHaveLength(2);
    });
});

describe("20px rounded-line icon registry", () => {
    test("declares the design contract", () => {
        expect(Icons.design).toEqual({
            grid: 20,
            strokeWidth: 1.5,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            minimumInteriorGap: 2,
            metaphor: "geometric-rounded-line"
        });
    });

    test.each(Object.entries(REQUIRED_FAMILIES))("covers every required %s action", (family, required) => {
        const actual = Icons.inventory()[family];
        required.forEach((name) => expect(actual).toContain(name));
    });

    test("covers universal controls and all empty-state illustrations", () => {
        const universal = Icons.inventory().universal;
        ["add", "close", "check", "search", "filter", "more", "refresh", "edit", "trash", "copy", "save", "import", "export", "play", "eye", "lock", "favorite", "favorite-on", "grid", "list", "info", "help"].forEach((name) => expect(universal).toContain(name));
        expect(Icons.artNames()).toEqual(expect.arrayContaining(["empty-library", "empty-search", "empty-presets", "empty-colorflow", "empty-easing", "empty-error", "empty-offline"]));
    });

    test("renders every functional icon as self-contained currentColor inline SVG", () => {
        Icons.names().forEach((name) => {
            const svg = Icons.render(name);
            expect(svg.startsWith("<svg")).toBe(true);
            expect(svg).toContain('viewBox="0 0 20 20"');
            expect(svg).toContain('stroke="currentColor"');
            expect(svg).toContain('stroke-width="1.5"');
            expect(svg).toContain('stroke-linecap="round"');
            expect(svg).toContain('stroke-linejoin="round"');
            expect(svg).toContain('aria-hidden="true"');
            expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(/<img|https?:|font-awesome|material-icons|lucide|heroicons|data:image|url\(/i);
        });
    });

    test("each newly drawn icon and illustration has unique geometry", () => {
        const iconBodies = Icons.names().map((name) => Icons.get(name).body);
        const artBodies = Icons.artNames().map((name) => Icons.getArt(name).body);
        expect(new Set(iconBodies).size).toBe(iconBodies.length);
        expect(new Set(artBodies).size).toBe(artBodies.length);
    });

    test("empty-state art follows the 48px currentColor rounded-line contract", () => {
        Icons.artNames().forEach((name) => {
            const svg = Icons.renderArt(name, { label: name });
            expect(svg).toContain('viewBox="0 0 48 48"');
            expect(svg).toContain('stroke="currentColor"');
            expect(svg).toContain('stroke-width="1.5"');
            expect(svg).toContain('role="img"');
            expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(/<img|https?:|data:image|url\(/i);
        });
    });

    test("accessible labels are escaped and decorative icons stay hidden", () => {
        expect(Icons.render("search", { label: 'Find <asset> & "apply"' })).toContain('aria-label="Find &lt;asset&gt; &amp; &quot;apply&quot;"');
        expect(Icons.render("search", { label: "Search" })).not.toContain('aria-hidden="true"');
        expect(Icons.render("search")).toContain('focusable="false"');
    });

    test("unknown identifiers fail closed and inventory copies cannot mutate registry", () => {
        expect(() => Icons.render("not-an-icon")).toThrow("Unknown CompSaver icon");
        expect(() => Icons.renderArt("not-art")).toThrow("Unknown CompSaver empty-state art");
        const copy = Icons.inventory();
        copy.navigation.length = 0;
        expect(Icons.inventory().navigation).toHaveLength(7);
    });
});
