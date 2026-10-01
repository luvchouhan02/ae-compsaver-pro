/**
 * Property 9 — Thumbnail refresh always uses a fresh cache-busting reference.
 *
 * Feature: save-import-performance-redesign — Task 5.6
 * Validates: Requirements 3.3
 *
 * What is under test
 * ------------------
 * The pure cache-busting token generator `nextThumbCacheToken(normFolder, mtime)`
 * defined in `js/templates/templates.js` (task 5.4). It combines the thumbnail
 * file's modification time with a strictly-increasing per-folder sequence so
 * every reference emitted for a card differs from the one emitted immediately
 * before it — even when two consecutive renders share the same (coarse) mtime.
 *
 * The design's Property 9 states: for ANY sequence of thumbnail updates for a
 * card whose file modification times are non-decreasing, each generated
 * thumbnail reference carries a cache-busting token that differs from the
 * immediately previous reference for that card, so no stale image can be
 * displayed.
 *
 * How the slice is loaded
 * -----------------------
 * `templates.js` is browser-side and has no module system (no `module.exports`,
 * it touches `document`, DOM helpers, etc.), so it cannot be `require()`d. This
 * test extracts the self-contained token slice — the module-level
 * `_thumbCacheSeq` map plus the `nextThumbCacheToken` function — FRESH from the
 * real source on every run and evaluates just that slice inside a `vm` sandbox.
 * Nothing is copied or re-implemented: the exact production function is exercised.
 *
 * fast-check + Jest, 100 iterations, no mocks, no filesystem.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const fc = require("fast-check");

const TEMPLATES_JS = path.resolve(__dirname, "..", "js", "templates", "templates.js");

/**
 * Extract the full source text of a top-level `function <name>(...) { ... }`
 * declaration from `source` using brace-depth matching (robust to nested
 * braces, strings kept verbatim). Returns the declaration text, or throws if
 * the function cannot be located.
 */
function extractFunctionSource(source, name) {
    const sig = "function " + name;
    const start = source.indexOf(sig);
    if (start === -1) throw new Error("could not find " + sig + " in templates.js");
    const openIdx = source.indexOf("{", start);
    if (openIdx === -1) throw new Error("no opening brace for " + name);

    let depth = 0;
    for (let i = openIdx; i < source.length; i++) {
        const ch = source[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error("unterminated function body for " + name);
}

/**
 * Load the real `nextThumbCacheToken` slice from templates.js into a fresh vm
 * sandbox. The function depends only on the module-level `_thumbCacheSeq` map
 * (declared here) and the standard `Math`/`Date` globals. Returns the live
 * function bound to a private, empty per-run sequence map.
 */
function loadTokenSlice() {
    const source = fs.readFileSync(TEMPLATES_JS, "utf8");
    const fnSource = extractFunctionSource(source, "nextThumbCacheToken");

    const sandbox = { Math: Math, Date: Date };
    vm.createContext(sandbox);
    // A private, empty backing map plus the real function declaration.
    vm.runInContext("var _thumbCacheSeq = Object.create(null);\n" + fnSource, sandbox, {
        filename: "templates.js#nextThumbCacheToken",
    });

    if (typeof sandbox.nextThumbCacheToken !== "function") {
        throw new Error("nextThumbCacheToken did not evaluate to a function");
    }
    return sandbox.nextThumbCacheToken;
}

// ─── Generators ──────────────────────────────────────────────────────────────

// Normalized (forward-slash) folder paths — the key `nextThumbCacheToken` uses.
const folderArb = fc
    .array(fc.stringMatching(/^[A-Za-z0-9_.-]{1,6}$/), { minLength: 1, maxLength: 4 })
    .map((segs) => segs.join("/"));

// A single thumbnail update carries an mtime *delta* (>= 0). Building a sequence
// from non-negative deltas guarantees the mtimes are non-decreasing, and the
// zero deltas exercise the crucial "same mtime, consecutive renders" case that a
// plain `?v=<mtime>` token would fail. Occasionally the mtime is absent (null),
// mirroring a stat() miss where the code falls back to Date.now().
const updateArb = fc.record({
    delta: fc.nat({ max: 5 }),
    present: fc.boolean(),
});

// A non-empty sequence of updates for one card.
const sequenceArb = fc.array(updateArb, { minLength: 1, maxLength: 30 });

// Turn a base mtime + deltas into an ascending mtime list, substituting null for
// "absent" updates (the stat-miss fallback path).
function buildMtimes(baseMtime, updates) {
    const out = [];
    let acc = baseMtime;
    for (const u of updates) {
        acc += u.delta;
        out.push(u.present ? acc : null);
    }
    return out;
}

// ─── Property 9 ───────────────────────────────────────────────────────────────
// Feature: save-import-performance-redesign, Property 9: Thumbnail refresh always uses a fresh cache-busting reference
describe("Property 9: Thumbnail refresh always uses a fresh cache-busting reference (Req 3.3)", () => {
    test("each token differs from the immediately previous token for the same card, across non-decreasing mtimes", () => {
        fc.assert(
            fc.property(
                folderArb,
                fc.nat({ max: 2_000_000_000 }),
                sequenceArb,
                (folder, baseMtime, updates) => {
                    const nextThumbCacheToken = loadTokenSlice();
                    const mtimes = buildMtimes(baseMtime, updates);

                    let prev = null;
                    for (const mtime of mtimes) {
                        const token = nextThumbCacheToken(folder, mtime);

                        // A token is always a non-empty string reference.
                        expect(typeof token).toBe("string");
                        expect(token.length).toBeGreaterThan(0);

                        // The core guarantee: the fresh reference differs from the
                        // one emitted immediately before it for THIS card — even
                        // when the mtime repeats (delta 0) or is absent.
                        if (prev !== null) {
                            expect(token).not.toBe(prev);
                        }
                        prev = token;
                    }
                }
            ),
            { numRuns: 100 }
        );
    });

    test("interleaved updates across multiple cards each stay fresh per card", () => {
        fc.assert(
            fc.property(
                fc.uniqueArray(folderArb, { minLength: 2, maxLength: 5 }),
                fc.nat({ max: 2_000_000_000 }),
                // A schedule of (cardIndex, update) steps interleaving several cards.
                fc.array(fc.record({ card: fc.nat(), update: updateArb }), {
                    minLength: 1,
                    maxLength: 60,
                }),
                (folders, baseMtime, schedule) => {
                    const nextThumbCacheToken = loadTokenSlice();
                    const lastToken = Object.create(null); // folder -> previous token
                    const lastMtime = Object.create(null); // folder -> running mtime

                    for (const step of schedule) {
                        const folder = folders[step.card % folders.length];
                        const base = lastMtime[folder] === undefined ? baseMtime : lastMtime[folder];
                        const nextMtime = base + step.update.delta;
                        lastMtime[folder] = nextMtime;

                        const token = nextThumbCacheToken(
                            folder,
                            step.update.present ? nextMtime : null
                        );

                        // Fresh vs. the immediately previous reference for THIS card.
                        if (lastToken[folder] !== undefined) {
                            expect(token).not.toBe(lastToken[folder]);
                        }
                        lastToken[folder] = token;
                    }
                }
            ),
            { numRuns: 100 }
        );
    });

    // ─── Focused examples (complement the universal property) ─────────────────
    test("two consecutive renders with an identical mtime still produce distinct tokens", () => {
        const nextThumbCacheToken = loadTokenSlice();
        const a = nextThumbCacheToken("root/card", 1000);
        const b = nextThumbCacheToken("root/card", 1000);
        expect(a).not.toBe(b);
    });

    test("the per-folder sequence is independent — interleaving another card never breaks a card's own freshness", () => {
        const nextThumbCacheToken = loadTokenSlice();
        const a1 = nextThumbCacheToken("card/a", 5);
        // An unrelated card's update lands in between …
        nextThumbCacheToken("card/b", 5);
        const a2 = nextThumbCacheToken("card/a", 5);
        // … yet card A's successive references remain distinct from each other.
        expect(a1).not.toBe(a2);
    });

    test("a missing mtime (stat miss) still yields a fresh token via the sequence", () => {
        const nextThumbCacheToken = loadTokenSlice();
        const a = nextThumbCacheToken("root/card", null);
        const b = nextThumbCacheToken("root/card", null);
        expect(a).not.toBe(b);
    });
});
