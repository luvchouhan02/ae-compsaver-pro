/**
 * CEP / Chromium 88+ compatibility — static-analysis tests.
 *
 * Validates: Requirements 18.1, 18.2, 18.3, 18.4, 18.5, 18.6
 *
 * These tests parse every stylesheet in `css/` as text and assert two
 * invariants required for the redesign to run in the Adobe CEP embedded
 * Chromium 88 runtime:
 *
 *   1. No CSS file uses a feature unsupported by Chromium 88:
 *      `:has(`, `@container`, `@layer`, or `color-mix(`  (Req 18.1–18.4).
 *   2. Every rule that declares `backdrop-filter` also declares a matching
 *      `-webkit-backdrop-filter` with the SAME value in the same rule block
 *      (Req 18.5) — so the glass effect renders in the WebKit-based runtime.
 *
 * Failures name the offending file + line so the violation is easy to locate.
 */

const fs = require("fs");
const path = require("path");

const CSS_DIR = path.resolve(__dirname, "..", "css");

/** Absolute paths of every `.css` file under css/. */
function cssFiles() {
    return fs
        .readdirSync(CSS_DIR)
        .filter((name) => name.toLowerCase().endsWith(".css"))
        .map((name) => path.join(CSS_DIR, name));
}

/** Read a file as UTF-8 text. */
function read(file) {
    return fs.readFileSync(file, "utf8");
}

/**
 * Blank out `/* ... *\/` comment bodies while preserving every character
 * position (newlines kept, everything else replaced by a space) so line numbers
 * in failure messages stay exact.
 *
 * Comments must be excluded from the forbidden-feature scan: several
 * stylesheets carry a header comment that literally documents the ban
 * ("Chromium 88 safe — no :has(), @container, @layer, or color-mix()"), and a
 * raw text scan flags those notes as violations. Stripping comments makes the
 * check strictly more accurate — real declarations are still caught, because
 * only comment bodies are blanked.
 */
function stripComments(content) {
    return content.replace(/\/\*[\s\S]*?\*\//g, (block) =>
        block.replace(/[^\n]/g, " ")
    );
}

/** 1-based line number of a character offset within `content`. */
function lineAt(content, index) {
    let line = 1;
    for (let i = 0; i < index && i < content.length; i++) {
        if (content[i] === "\n") line++;
    }
    return line;
}

// Sanity: there must be CSS to analyze, otherwise the suite is vacuously green.
const FILES = cssFiles();

describe("CEP / Chromium 88+ compatibility static analysis", () => {
    test("css/ directory contains stylesheets to analyze", () => {
        expect(FILES.length).toBeGreaterThan(0);
    });

    // ── Forbidden-feature scan (Req 18.1–18.4) ──────────────────────────────
    // One test per forbidden feature. Each scans every CSS file line-by-line
    // and collects `file:line` for every occurrence so the failure message
    // points straight at the offending location.
    const FORBIDDEN = [
        { feature: ":has()", token: ":has(", requirement: "18.1" },
        { feature: "@container", token: "@container", requirement: "18.2" },
        { feature: "@layer", token: "@layer", requirement: "18.3" },
        { feature: "color-mix()", token: "color-mix(", requirement: "18.4" },
    ];

    describe.each(FORBIDDEN)(
        "forbidden feature: $feature (Req $requirement)",
        ({ feature, token }) => {
            test(`no CSS file contains \`${token}\``, () => {
                const offences = [];
                for (const file of FILES) {
                    const rel = path.relative(CSS_DIR, file);
                    const original = read(file).split(/\r?\n/);
                    const lines = stripComments(read(file)).split(/\r?\n/);
                    lines.forEach((text, i) => {
                        if (text.includes(token)) {
                            offences.push(
                                `  css/${rel}:${i + 1}  →  ${(original[i] || text).trim()}`
                            );
                        }
                    });
                }
                if (offences.length > 0) {
                    throw new Error(
                        `Found forbidden \`${feature}\` (unsupported in Chromium 88). ` +
                        `Remove it from:\n${offences.join("\n")}`
                    );
                }
                expect(offences).toEqual([]);
            });
        }
    );

    // ── backdrop-filter pairing (Req 18.5) ──────────────────────────────────
    // For every rule block that declares `backdrop-filter`, assert a sibling
    // `-webkit-backdrop-filter` with the SAME value exists in the same block.
    describe("backdrop-filter is always paired with -webkit-backdrop-filter (Req 18.5)", () => {
        test("every backdrop-filter has a matching -webkit-backdrop-filter with the same value", () => {
            const problems = [];

            for (const file of FILES) {
                const rel = path.relative(CSS_DIR, file);
                const content = read(file);

                // Leaf rule blocks = `{ ... }` containing no nested braces.
                // These are the innermost declaration blocks where
                // backdrop-filter lives (selector or @media-nested rule).
                const leafBlock = /\{([^{}]*)\}/g;
                let match;
                while ((match = leafBlock.exec(content)) !== null) {
                    const body = match[1];
                    const bodyStart = match.index + 1; // offset of body within file

                    const std = [];
                    const webkit = [];

                    // Walk each declaration in the block, tracking its offset
                    // so we can report an accurate line number.
                    let offset = 0;
                    for (const decl of body.split(";")) {
                        const declOffset = bodyStart + offset;
                        offset += decl.length + 1; // +1 for the ';' removed by split

                        const colon = decl.indexOf(":");
                        if (colon === -1) continue;

                        const prop = decl.slice(0, colon).trim().toLowerCase();
                        const value = decl.slice(colon + 1).trim();

                        if (prop === "backdrop-filter") {
                            std.push({ value, offset: declOffset });
                        } else if (prop === "-webkit-backdrop-filter") {
                            webkit.push({ value });
                        }
                    }

                    // Each standard declaration needs a webkit sibling whose
                    // value matches (whitespace-normalized).
                    for (const d of std) {
                        const wanted = normalize(d.value);
                        const paired = webkit.some(
                            (w) => normalize(w.value) === wanted
                        );
                        if (!paired) {
                            const ln = lineAt(content, d.offset);
                            const have = webkit.length
                                ? webkit
                                    .map((w) => `-webkit-backdrop-filter: ${w.value}`)
                                    .join("; ")
                                : "(none)";
                            problems.push(
                                `  css/${rel}:${ln}  →  backdrop-filter: ${d.value};  ` +
                                `missing matching -webkit-backdrop-filter: ${d.value};  ` +
                                `[present in block: ${have}]`
                            );
                        }
                    }
                }
            }

            if (problems.length > 0) {
                throw new Error(
                    `Unpaired/mismatched backdrop-filter declaration(s). Each ` +
                    `backdrop-filter must have a -webkit-backdrop-filter with the ` +
                    `same value in the same rule block:\n${problems.join("\n")}`
                );
            }
            expect(problems).toEqual([]);
        });
    });
});

/** Collapse internal whitespace so value comparison ignores formatting. */
function normalize(value) {
    return value.replace(/\s+/g, " ").trim();
}
