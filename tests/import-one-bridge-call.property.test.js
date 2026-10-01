// Feature: save-import-performance-redesign, Property 17: Import uses exactly one Bridge_Call per user action
//
// Property test for the batching, cache-first Import_Engine CEP client
// (`importTemplates` in js/core/importEngine.js, Task 7.1 / 7.2).
//
// Design Property 17 (Validates: Requirements 9.1, 9.2, 9.3):
//   For ANY import action selecting between 1 and 500 templates (with data NOT
//   already cached), the Import_Engine issues EXACTLY ONE Bridge_Call to the
//   host, and that single call's payload contains EVERY selected template.
//
// How it is exercised
// -------------------
// importEngine.js is a pure, dependency-injected CommonJS module, so we require
// it directly and inject a `callHost` spy that counts every Bridge_Call and
// captures each payload. `resolveCached` is forced to "nothing cached" so every
// selected template must ride the single host call (the cached-request case is
// Property 18, task 7.3). encode/decode are identity codecs so the test can
// decode the captured payload back to JSON and inspect it.
//
// fast-check generates a random action of 1..500 uniquely-identified templates
// (min 100 iterations). For each action we prove:
//   - exactly one Bridge_Call is issued (spy call count === 1, result
//     bridgeCalls === 1); and
//   - that single call's payload carries every selected template, in order.

"use strict";

const fc = require("fast-check");
const { importTemplates } = require("../js/core/importEngine.js");

// Identity codecs: the payload string round-trips through encode/decode
// unchanged, so the captured payloadHex is exactly the JSON we can re-parse.
const identity = (s) => String(s);

/**
 * Build a fresh import harness with a Bridge_Call spy.
 *
 * `callHost` records every invocation (proving the count) and captures the
 * payload string, then responds with a well-formed host result that marks each
 * requested template `imported` so `importTemplates` completes normally.
 */
function makeHarness() {
    const calls = []; // one entry per Bridge_Call: { payload }

    function callHost(payloadHex, cb) {
        const payload = JSON.parse(identity(payloadHex)); // decode + parse
        calls.push({ payload });

        // Respond with a total per-template result so the client resolves.
        const perTemplate = payload.templates.map((t) => ({
            id: t.id,
            status: "imported",
        }));
        cb(identity(JSON.stringify({ perTemplate })));
    }

    return {
        calls,
        deps: {
            callHost,
            // Nothing is cached — every template must cross the Bridge.
            resolveCached: () => null,
            encode: identity,
            decode: identity,
            onStarted: () => { },
        },
    };
}

// An import action of 1..500 templates with GUARANTEED-unique ids (id derived
// from the array index) plus varied, randomized descriptor fields so the
// property holds across the whole input space, not just distinct-name cases.
const arbTemplateSeeds = fc.array(
    fc.record({
        name: fc.string({ maxLength: 24 }),
        category: fc.string({ maxLength: 16 }),
        section: fc.constantFrom("comp", "layer", "text", "footage", "effect", "icon"),
        folderPath: fc.string({ maxLength: 40 }),
    }),
    { minLength: 1, maxLength: 500 }
);

const arbRootPath = fc.string({ maxLength: 40 });

describe("Property 17: Import uses exactly one Bridge_Call per user action (Req 9.1, 9.2, 9.3)", () => {
    it("issues exactly one Bridge_Call whose single payload carries every selected template", () => {
        fc.assert(
            fc.property(arbRootPath, arbTemplateSeeds, (rootPath, seeds) => {
                const templates = seeds.map((seed, i) => ({
                    id: "tpl-" + i, // index-derived → unique across the action
                    name: seed.name,
                    category: seed.category,
                    section: seed.section,
                    folderPath: seed.folderPath,
                }));

                const h = makeHarness();
                let result = null;
                importTemplates(h.deps, { rootPath, templates }, (r) => {
                    result = r;
                });

                // (A) EXACTLY ONE Bridge_Call was issued — both as observed by
                // the transport spy and as reported by the client result.
                expect(h.calls.length).toBe(1);
                expect(result).not.toBeNull();
                expect(result.bridgeCalls).toBe(1);

                // (B) The single payload carries EVERY selected template, in
                // input order (one-to-one, none dropped, none added).
                const payloadTemplates = h.calls[0].payload.templates;
                expect(payloadTemplates.length).toBe(templates.length);
                expect(payloadTemplates.map((t) => t.id)).toEqual(
                    templates.map((t) => t.id)
                );

                // (C) The result is total over the input: one entry per selected
                // template, in order.
                expect(result.perTemplate.length).toBe(templates.length);
                expect(result.perTemplate.map((e) => e.id)).toEqual(
                    templates.map((t) => t.id)
                );
            }),
            { numRuns: 100 }
        );
    });
});
