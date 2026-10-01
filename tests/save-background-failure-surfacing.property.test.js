// Feature: save-import-performance-redesign, Property 5: Background failure after essential success is surfaced without losing the essential result
//
// Property test for the redesigned async Save_Engine CEP controller
// (`runSaveController` in js/core/saveController.js, Task 5.1 / 5.3).
//
// Design Property 5 (Validates: Requirements 1.6, 5.7):
//   For any Non_Essential_Save_Work failure that occurs AFTER the essential
//   save has succeeded, the controller RETAINS the completed essential result
//   and RECORDS an error indication that IDENTIFIES the failed background work.
//
// The harness injects a pure `callHost` spy that always resolves an essential
// SUCCESS, and a `scheduleBackground` spy that deterministically drives a
// generated mix of background-work outcomes (some failing) through the
// `onWorkFailed(workName, err)` / `onAllSettled()` hooks the controller hands
// it. Because the controller schedules background work synchronously inside the
// essential-success branch, every driven failure is recorded before the
// returned Promise resolves, so the resolved state is the observation point.
//
// No mocks of the module under test, no filesystem, no After Effects — the
// control-flow guarantee is exercised purely through injected dependencies.

const fc = require("fast-check");
const { runSaveController } = require("../js/core/saveController.js");

// Background-work kinds the redesign schedules as Non_Essential_Save_Work.
const WORK_KINDS = ["thumbnail", "preview", "index", "metadata"];

// A single unit of scheduled background work: a kind, whether it fails, and the
// error value it fails with (varied across the shapes onWorkFailed tolerates).
const workUnitArb = fc.record({
    kind: fc.constantFrom(...WORK_KINDS),
    willFail: fc.boolean(),
    error: fc.oneof(
        fc.string({ maxLength: 20 }),
        fc.constant(new Error("boom")),
        fc.record({ message: fc.string({ minLength: 1, maxLength: 20 }) }),
        fc.constant(null)
    ),
});

// The essential-save SUCCESS payload the host returns. Always carries ok:true
// (so the controller classifies it as an essential success) plus a varying set
// of host-returned fields that must survive intact on the retained result.
const successPayloadArb = fc
    .record(
        {
            ok: fc.constant(true),
            folderPath: fc.string({ minLength: 1, maxLength: 24 }),
            name: fc.string({ maxLength: 16 }),
            category: fc.string({ maxLength: 12 }),
            needsThumbnail: fc.boolean(),
            assetsList: fc.array(fc.string({ maxLength: 8 }), { maxLength: 5 }),
        },
        { requiredKeys: ["ok"] }
    );

// Reduce an error value the same way the controller does, so we can assert the
// recorded backgroundErrors[].error matches exactly.
function reduceError(err) {
    return err != null ? String(err && err.message ? err.message : err) : "unknown";
}

describe("Property 5: Background failure after essential success is surfaced without losing the essential result", () => {
    // Feature: save-import-performance-redesign, Property 5: Background failure after essential success is surfaced without losing the essential result
    // Validates: Requirements 1.6, 5.7
    test("retains the essential result and records an identifying error for every failed background unit", async () => {
        await fc.assert(
            fc.asyncProperty(
                successPayloadArb,
                fc.array(workUnitArb, { maxLength: 8 }),
                // A guaranteed-failing unit ensures the "background failure after
                // essential success" precondition of Property 5 always holds.
                workUnitArb,
                async (successPayload, units, guaranteedFail) => {
                    // Assemble the full work list with at least one failure, and
                    // assign each unit a unique, identifiable name.
                    const rawUnits = units.concat([{ ...guaranteedFail, willFail: true }]);
                    const workUnits = rawUnits.map((u, i) => ({
                        ...u,
                        name: `${u.kind}#${i}`,
                    }));
                    const failing = workUnits.filter((u) => u.willFail);

                    // ── Injected spies ────────────────────────────────────────
                    let callHostCalls = 0;
                    const callHost = () => {
                        callHostCalls++;
                        // Async-Bridge outcome wrapping an essential SUCCESS.
                        return Promise.resolve({ ok: true, result: successPayload });
                    };

                    let essentialErrorSet = false;
                    const setError = () => {
                        essentialErrorSet = true;
                    };

                    const backgroundErrorMessages = [];
                    const setBackgroundError = (msg) => {
                        backgroundErrorMessages.push(msg);
                    };

                    let onSuccessArg = undefined;
                    let onSuccessCalls = 0;
                    const onEssentialSuccess = (result) => {
                        onSuccessCalls++;
                        onSuccessArg = result;
                    };

                    let bgActivityShown = 0;
                    let bgActivityHidden = 0;

                    // Drives the generated background outcomes through the hooks
                    // exactly as the real Background_Queue would report them.
                    const scheduleBackground = (result, hooks) => {
                        for (const u of workUnits) {
                            if (u.willFail) hooks.onWorkFailed(u.name, u.error);
                        }
                        hooks.onAllSettled();
                    };

                    const state = await runSaveController(
                        {
                            callHost,
                            setError,
                            setBackgroundError,
                            onEssentialSuccess,
                            scheduleBackground,
                            showBackgroundActivity: () => {
                                bgActivityShown++;
                            },
                            hideBackgroundActivity: () => {
                                bgActivityHidden++;
                            },
                        },
                        { scriptCall: "essentialSave()" }
                    );

                    // ── (0) Exactly one essential Bridge_Call was issued. ──────
                    expect(callHostCalls).toBe(1);

                    // ── (1) Essential result is RETAINED, not lost. ────────────
                    // The controller classified the save as an essential success,
                    // exited loading, and kept the completed essential result
                    // intact despite the background failures.
                    expect(state.loadingExited).toBe(true);
                    expect(state.essentialOk).toBe(true);
                    expect(state.essentialResult).toEqual(successPayload);
                    // The retained result is exactly what the optimistic UI hook
                    // received — the essential outcome was not discarded.
                    expect(onSuccessCalls).toBe(1);
                    expect(onSuccessArg).toEqual(successPayload);
                    // No essential-failure error indication is raised on success.
                    expect(essentialErrorSet).toBe(false);
                    expect(state.essentialError).toBeNull();

                    // ── (2) An identifying error is RECORDED per failed unit. ──
                    // One recorded error per failing background unit, in order,
                    // each naming the work that failed (so it is distinguishable
                    // from the retained, successful essential save).
                    expect(state.backgroundErrors.length).toBe(failing.length);
                    expect(state.backgroundErrors.map((e) => e.work)).toEqual(
                        failing.map((u) => u.name)
                    );
                    state.backgroundErrors.forEach((rec, i) => {
                        expect(rec.error).toBe(reduceError(failing[i].error));
                    });

                    // Every surfaced error indication IDENTIFIES its work unit by
                    // name (Req 1.6 — "identifying the failed background work").
                    expect(backgroundErrorMessages.length).toBe(failing.length);
                    backgroundErrorMessages.forEach((msg, i) => {
                        expect(msg).toContain(failing[i].name);
                    });

                    // ── (3) Non-blocking activity indicator settled cleanly. ───
                    // The indicator was shown while work was pending and hidden
                    // once all background work settled — the controller never
                    // re-entered the blocking loading state for background work.
                    expect(bgActivityShown).toBe(1);
                    expect(bgActivityHidden).toBe(1);
                    expect(state.backgroundActivityVisible).toBe(false);
                    expect(state.backgroundSettled).toBe(true);
                }
            ),
            { numRuns: 100 }
        );
    });
});
