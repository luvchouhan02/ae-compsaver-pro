// Feature: save-import-performance-redesign, Property 4: Save controller exits loading on essential completion regardless of background state
//
// Property test for the pure, dependency-injected async save controller
// (`runSaveController` in js/core/saveController.js, Task 5.1 / 5.2).
//
// Design Property 4 (Validates: Requirements 1.3, 1.5):
//   For ANY essential-save result (success or failure), the save controller
//   transitions OUT of the save loading state, and this transition does NOT
//   depend on the state of any Non_Essential_Save_Work; on an essential
//   failure it ALSO sets an error indication.
//
// How it is exercised
// -------------------
// `runSaveController` is pure: every side-effecting collaborator is injected.
// We drive it with a fake async `callHost` that delivers a randomly-generated
// essential outcome (success or one of many failure shapes) either as a plain
// value, a resolved Promise, or a rejected Promise, and a `scheduleBackground`
// spy that models every possible Non_Essential_Save_Work behavior: absent,
// settle-immediately, fail-then-settle, fail-and-never-settle, never-settle,
// and throw-on-schedule.
//
// Across the full cross product (min 100 iterations) we prove the loading-state
// exit is invariant:
//   • `exitLoading` is called EXACTLY ONCE and `state.loadingExited` is true on
//     every path — regardless of the background scenario (independence);
//   • the loading exit happens BEFORE any background work is scheduled (so the
//     transition cannot depend on Non_Essential_Save_Work state);
//   • on an essential FAILURE an error indication is set and NO background work
//     is scheduled;
//   • on an essential SUCCESS the essential result is retained.

"use strict";

const fc = require("fast-check");
const { runSaveController, defaultParseEssential } = require("../js/core/saveController");

// ── Essential-outcome arbitraries ──────────────────────────────────────────
// Success shapes: a JSON object body that parses to { ok:true, ... }, or the
// legacy monolithic "true" sentinel.
const arbSuccessOutcome = fc.oneof(
    fc
        .record({
            folderPath: fc
                .array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 4 })
                .map((parts) => parts.join("/")),
            name: fc.string({ maxLength: 20 }),
            category: fc.string({ maxLength: 12 }),
            needsThumbnail: fc.boolean(),
        })
        .map((obj) => ({ ok: true, result: JSON.stringify(Object.assign({ ok: true }, obj)) })),
    fc.constant({ ok: true, result: "true" })
);

// Failure shapes spanning every failure branch the controller distinguishes:
// transport failure, timeout, empty/false sentinels, an "ERROR:" string, and
// an unparseable JSON body.
const arbFailureOutcome = fc.oneof(
    fc.string({ minLength: 1, maxLength: 20 }).map((error) => ({ ok: false, error })),
    fc.constant({ ok: false, timedOut: true }),
    fc.constant({ ok: true, result: "" }),
    fc.constant({ ok: true, result: "false" }),
    fc.string({ minLength: 1, maxLength: 15 }).map((s) => ({ ok: true, result: "ERROR: " + s })),
    fc.constant({ ok: true, result: "{ not valid json" })
);

const arbOutcome = fc.oneof(arbSuccessOutcome, arbFailureOutcome);

// How the fake Bridge hands the outcome back to the controller.
const arbDeliver = fc.constantFrom("value", "resolve", "reject");

// Every Non_Essential_Save_Work behavior the scheduler could exhibit.
const BG_SCENARIOS = [
    "none", // scheduleBackground not injected at all
    "settleImmediately", // schedules, all work settles at once, no failures
    "failThenSettle", // a unit fails, then everything settles
    "failNoSettle", // a unit fails but the queue never reports "all settled"
    "neverSettle", // background work stays pending forever
    "throw", // scheduling itself throws
];
const arbBgScenario = fc.constantFrom(...BG_SCENARIOS);

// The request; the default buildEssentialCall reads request.scriptCall.
const arbRequest = fc.record({ scriptCall: fc.string({ maxLength: 30 }) });

// Mirror the controller's own success predicate so expectations never depend on
// how an outcome was labelled by the generator.
function expectSuccess(deliver, outcome) {
    if (deliver === "reject") return false;
    if (!outcome || outcome.ok !== true) return false;
    const parsed = defaultParseEssential(outcome.result);
    return !!(parsed && parsed.ok);
}

// Feature: save-import-performance-redesign, Property 4: Save controller exits loading on essential completion regardless of background state
describe("Property 4: Save controller exits loading on essential completion regardless of background state (Req 1.3, 1.5)", () => {
    test("exits loading exactly once, before any background scheduling, for every essential result and background scenario", async () => {
        await fc.assert(
            fc.asyncProperty(
                arbOutcome,
                arbDeliver,
                arbBgScenario,
                arbRequest,
                async (outcome, deliver, bgScenario, request) => {
                    const order = [];
                    let callHostCount = 0;
                    let exitCount = 0;
                    let scheduleCount = 0;
                    let showActivity = 0;
                    const errorCalls = [];
                    const bgErrorCalls = [];
                    const successCalls = [];

                    const deps = {
                        callHost: function () {
                            callHostCount++;
                            if (deliver === "value") return outcome;
                            if (deliver === "resolve") return Promise.resolve(outcome);
                            return Promise.reject(new Error("transport blew up"));
                        },
                        exitLoading: function () {
                            exitCount++;
                            order.push("exit");
                        },
                        setError: function (msg) {
                            errorCalls.push(msg);
                        },
                        setBackgroundError: function (msg) {
                            bgErrorCalls.push(msg);
                        },
                        onEssentialSuccess: function (result) {
                            successCalls.push(result);
                        },
                        showBackgroundActivity: function () {
                            showActivity++;
                        },
                        hideBackgroundActivity: function () { },
                    };

                    if (bgScenario !== "none") {
                        deps.scheduleBackground = function (result, hooks) {
                            scheduleCount++;
                            order.push("schedule");
                            switch (bgScenario) {
                                case "settleImmediately":
                                    hooks.onAllSettled();
                                    break;
                                case "failThenSettle":
                                    hooks.onWorkFailed("thumbnail", new Error("render failed"));
                                    hooks.onAllSettled();
                                    break;
                                case "failNoSettle":
                                    hooks.onWorkFailed("preview", new Error("render failed"));
                                    break;
                                case "neverSettle":
                                    // Background work stays pending forever.
                                    break;
                                case "throw":
                                    throw new Error("scheduling blew up");
                                default:
                                    break;
                            }
                        };
                    }

                    const state = await runSaveController(deps, request);

                    const succeeded = expectSuccess(deliver, outcome);

                    // The Bridge is issued exactly once for the essential save.
                    expect(callHostCount).toBe(1);

                    // (A) INVARIANT — loading is exited exactly once on every
                    // path, and the state records the transition. This holds for
                    // ALL background scenarios, including throw / never-settle,
                    // proving independence from Non_Essential_Save_Work state.
                    expect(state.loadingExited).toBe(true);
                    expect(exitCount).toBe(1);

                    // (B) The loading exit precedes any background scheduling, so
                    // the transition cannot depend on background state.
                    const exitIdx = order.indexOf("exit");
                    const scheduleIdx = order.indexOf("schedule");
                    expect(exitIdx).toBe(0);
                    if (scheduleIdx !== -1) {
                        expect(exitIdx).toBeLessThan(scheduleIdx);
                    }

                    if (succeeded) {
                        // (C) Essential success: result retained and handed to
                        // the optimistic-UI hook.
                        expect(state.essentialOk).toBe(true);
                        expect(state.essentialResult).toBeTruthy();
                        expect(state.essentialResult.ok).toBe(true);
                        expect(successCalls.length).toBe(1);
                        if (bgScenario !== "none") {
                            expect(scheduleCount).toBe(1);
                        }
                    } else {
                        // (D) Essential failure: an error indication is set, the
                        // result is not retained, and NO background work runs.
                        expect(state.essentialOk).toBe(false);
                        expect(typeof state.essentialError).toBe("string");
                        expect(state.essentialError.length).toBeGreaterThan(0);
                        expect(errorCalls.length).toBeGreaterThanOrEqual(1);
                        expect(state.essentialResult).toBeNull();
                        expect(scheduleCount).toBe(0);
                        expect(showActivity).toBe(0);
                        expect(successCalls.length).toBe(0);
                    }
                }
            ),
            { numRuns: 200 }
        );
    });
});
