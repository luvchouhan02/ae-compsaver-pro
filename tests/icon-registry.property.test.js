"use strict";

const fc = require("fast-check");
const Icons = require("../js/ui/icons");

/**
 * Property: every registry entry renders deterministically as a bounded,
 * dependency-free currentColor SVG while preserving accessible text escaping.
 * **Validates: Requirements 6.2, 6.3, 6.6**
 */
describe("Foldframe icon rendering properties", () => {
    test("all generated icon render requests preserve the inline SVG contract", () => {
        const names = Icons.names();
        fc.assert(fc.property(
            fc.constantFrom(...names),
            fc.integer({ min: 8, max: 128 }),
            fc.string({ maxLength: 40 }),
            (name, size, label) => {
                const options = label.length ? { size, label } : { size };
                const first = Icons.render(name, options);
                const second = Icons.render(name, options);
                expect(first).toBe(second);
                expect(first).toContain(`width="${size}"`);
                expect(first).toContain(`height="${size}"`);
                expect(first).toContain('stroke="currentColor"');
                expect(first.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(/https?:|<img|data:image|url\(|require\(|import\s/i);
                if (label.length) {
                    expect(first).toContain('role="img"');
                    expect(first).not.toContain('aria-hidden="true"');
                } else {
                    expect(first).toContain('aria-hidden="true"');
                }
            }
        ), { numRuns: 100 });
    });

    test("all generated illustration requests preserve the 48-grid contract", () => {
        const names = Icons.artNames();
        fc.assert(fc.property(
            fc.constantFrom(...names),
            fc.integer({ min: 24, max: 192 }),
            (name, size) => {
                const svg = Icons.renderArt(name, { size, label: name });
                expect(svg).toContain('viewBox="0 0 48 48"');
                expect(svg).toContain(`width="${size}"`);
                expect(svg).toContain('stroke="currentColor"');
                expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(/https?:|<img|data:image|url\(/i);
            }
        ), { numRuns: 50 });
    });
});
