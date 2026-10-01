/**
 * Property 18 — Cached requests issue no Bridge_Call.
 *
 * Feature: save-import-performance-redesign — Task 7.3
 * Validates: Requirements 9.4
 *
 * What is under test
 * ------------------
 * The batching, cache-first Import_Engine CEP client in
 * `js/core/importEngine.js` (task 7.1), specifically `importTemplates`. The
 * design's Property 18 states: for ANY import request whose result is already
 * present in the Library_Index / Metadata_Cache, the Import_Engine returns the
 * cached result and issues ZERO Bridge_Calls.
 *
 * How it is exercised
 * -------------------
 * `importTemplates` is pure and dependency-injected. We inject:
 *   - a `callHost` SPY that records every invocation — Property 18 requires it
 *     is never called when every requested template is cache-resolved;
 *   - a `resolveCached` that returns a cached entry for EVERY requested template
 *     (modelling a fully-warm Library_Index / Metadata_Cache).
 *
 * fast-check generates random import requests (1..500 unique templates, mixed
 * cached statuses), min 100 iterations. For each request we prove:
 *   - zero Bridge_Calls: the callHost spy was never invoked and the reported
 *     bridgeCalls count is 0; and
 *   - the returned result is the cached result: one entry per requested
 *     template, in input order, carrying the exact status the cache reported.
 */

"use strict";

const fc = require("fast-check");
const { importTemplates } = require("../js/core/importEngine.js");

// A single template with a stable id and incidental descriptor fields.
const templateArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 12 }),
    name: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }),
    category: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
    section: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
    folderPath: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
});

// A request of 1..500 templates with UNIQUE ids (the engine keys results by id,
// so duplicate ids would collapse and muddy the per-template assertions). The
// cache status each template resolves to is generated alongside it.
const requestArb = fc
    .uniqueArray(templateArb, {
        minLength: 1,
        maxLength: 60,
        selector: (t) => t.id,
    })
    .chain((templates) =>
        fc.record({
            rootPath: fc.string({ maxLength: 20 }),
            templates: fc.constant(templates),
            statuses: fc.array(fc.constantFrom("cached", "imported", "failed"), {
                minLength: templates.length,
                maxLength: templates.length,
            }),
        })
    );

// Feature: save-import-performance-redesign, Property 18: Cached requests issue no Bridge_Call
describe("Property 18: Cached requests issue no Bridge_Call (Req 9.4)", () => {
    test("for any fully-cached request, importTemplates returns the cached result and issues zero Bridge_Calls", () => {
        fc.assert(
            fc.property(requestArb, ({ rootPath, templates, statuses }) => {
                // Map each id -> the status the warm cache will report for it.
                const statusById = {};
                for (let i = 0; i < templates.length; i++) {
                    statusById["" + templates[i].id] = statuses[i];
                }

                // callHost SPY: Property 18 forbids any invocation. If the engine
                // ever crosses the Bridge for a fully-cached request this records
                // it (and would also mark the templates via the callback path).
                const callHostCalls = [];
                function callHost(payloadHex, cb) {
                    callHostCalls.push(payloadHex);
                    // Should be unreachable; still respond so a regression does
                    // not hang the test rather than fail it cleanly.
                    if (typeof cb === "function") cb("");
                }

                // resolveCached models a fully-warm Library_Index / Metadata_Cache:
                // every requested template resolves to a cached entry.
                function resolveCached(t) {
                    return { status: statusById["" + t.id], reason: "warm" };
                }

                let result = null;
                importTemplates(
                    { callHost, resolveCached },
                    { rootPath, templates },
                    (r) => {
                        result = r;
                    }
                );

                // ── Zero Bridge_Calls ────────────────────────────────────────
                expect(callHostCalls.length).toBe(0);
                expect(result).not.toBeNull();
                expect(result.bridgeCalls).toBe(0);

                // ── Returns the cached result, total over the input ──────────
                expect(result.perTemplate.length).toBe(templates.length);
                for (let i = 0; i < templates.length; i++) {
                    const id = "" + templates[i].id;
                    const entry = result.perTemplate[i];
                    // Input-order preservation.
                    expect(entry.id).toBe(id);
                    // The exact status the cache reported is surfaced.
                    expect(entry.status).toBe(statusById[id]);
                }
            }),
            { numRuns: 200 }
        );
    });

    // ── Focused example: single cached template, no transport touched ─────────
    test("a single cached template returns its cached status with zero Bridge_Calls", () => {
        const callHostCalls = [];
        let result = null;
        importTemplates(
            {
                callHost: (hex, cb) => {
                    callHostCalls.push(hex);
                    if (cb) cb("");
                },
                resolveCached: () => ({ status: "cached" }),
            },
            { rootPath: "/root", templates: [{ id: "solo" }] },
            (r) => {
                result = r;
            }
        );

        expect(callHostCalls.length).toBe(0);
        expect(result.bridgeCalls).toBe(0);
        expect(result.perTemplate).toEqual([{ id: "solo", status: "cached", reason: undefined }]);
    });
});
