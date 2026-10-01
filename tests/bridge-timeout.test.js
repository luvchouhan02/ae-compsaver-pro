/**
 * Async Bridge wrapper — timeout behavior (property test)
 * =======================================================
 * Feature: save-import-performance-redesign, Property 6: Bridge calls resolve as failed on timeout
 *
 * Exercises the pure, dependency-injected `callHost(scriptCall, { timeoutMs, csInterface })`
 * from `js/core/bridge.js` (task 1.1).
 *
 * Property 6: For any host response time, the async Bridge wrapper resolves with
 * the decoded result when the host returns BEFORE the timeout, and resolves as a
 * failed/timed-out outcome (without blocking) when the host returns AFTER the
 * timeout or never returns.
 *
 * Jest fake timers drive the host response time relative to the timeout so the
 * early-return / late-return / never-return branches are exercised deterministically.
 *
 * Validates: Requirements 1.7
 */

const fc = require("fast-check");
const { callHost, encodeBridge } = require("../js/core/bridge.js");

// A CSInterface stub whose evalScript delivers the (hex-encoded) host response
// after `responseTime` ms via a fake-timer-controlled setTimeout — or never, for
// the never-return scenario. This is the only side the wrapper talks to.
function makeIface(scenario) {
    return {
        calls: 0,
        evalScript(script, cb) {
            this.calls++;
            if (scenario.kind === "never") {
                // Host never returns: no callback is ever invoked.
                return;
            }
            // Host returns after `responseTime` ms with a hex-encoded payload,
            // exactly as the real ExtendScript transport would.
            setTimeout(function () {
                cb(encodeBridge(scenario.payload));
            }, scenario.responseTime);
        },
    };
}

// Scenario generator: pick a timeout, then pick when (or whether) the host returns
// relative to it. Payloads are non-empty printable strings so the hex codec
// round-trips and the wrapper's empty/sentinel guards don't fire spuriously.
const scenarioArb = fc
    .integer({ min: 1, max: 60000 })
    .chain((timeoutMs) =>
        fc.oneof(
            // Host returns strictly before the timeout -> decoded success.
            fc.record({
                kind: fc.constant("early"),
                timeoutMs: fc.constant(timeoutMs),
                responseTime: fc.integer({ min: 0, max: timeoutMs - 1 }),
                payload: fc.string({ minLength: 1, maxLength: 60 }),
            }),
            // Host returns strictly after the timeout -> timed-out; late reply dropped.
            fc.record({
                kind: fc.constant("late"),
                timeoutMs: fc.constant(timeoutMs),
                responseTime: fc.integer({
                    min: timeoutMs + 1,
                    max: timeoutMs + 100000,
                }),
                payload: fc.string({ minLength: 1, maxLength: 60 }),
            }),
            // Host never returns -> timed-out.
            fc.record({
                kind: fc.constant("never"),
                timeoutMs: fc.constant(timeoutMs),
            })
        )
    );

// Malformed / truncated payloads (bugfix comp-template-pipeline-audit-fix, R7 /
// Requirement 2.15). callHost used to hand every non-empty, non-sentinel reply
// straight to decodeBridge, so a corrupted transfer became a corrupted STRING:
// a bad 4-char chunk decoded to U+0000 on the panel while the host skipped it,
// and a trailing partial chunk yielded a plausible-but-wrong character on both
// sides. One payload, two different results, and no error reported either side.
// A well-formed payload is a multiple of four hex digits, so both shapes below
// are detectable with a single whole-string check.
const malformedPayloadArb = fc.oneof(
    // Length is not a multiple of four — a truncated transfer.
    fc.constantFrom("0", "004", "0048006", "00480065006"),
    // Correct length, but not hex.
    fc.constantFrom("zzzz", "----", "00480065ZZZZ00680065"),
    // Generated: a well-formed payload with its last digit lost in transit.
    fc
        .string({ minLength: 1, maxLength: 20 })
        .map((s) => encodeBridge(s))
        .map((hex) => hex.slice(0, hex.length - 1))
);

describe("Property 6: Bridge calls resolve as failed on timeout", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test("resolves decoded result before timeout, times out on late/never return", async () => {
        await fc.assert(
            fc.asyncProperty(scenarioArb, async (scenario) => {
                const iface = makeIface(scenario);

                const pending = callHost("hostCall()", {
                    timeoutMs: scenario.timeoutMs,
                    csInterface: iface,
                });

                // Advance past both the timeout and any scheduled host response so
                // every pending timer fires; the wrapper's latch decides the winner.
                const horizon =
                    Math.max(scenario.timeoutMs, scenario.responseTime || 0) + 10;
                jest.advanceTimersByTime(horizon);

                const outcome = await pending;

                // The wrapper NEVER rejects — it always resolves a plain object.
                expect(outcome).toBeDefined();

                if (scenario.kind === "early") {
                    // Host beat the timeout: decoded success, no timeout flag.
                    expect(outcome.ok).toBe(true);
                    expect(outcome.result).toBe(scenario.payload);
                    expect(outcome.timedOut).toBeUndefined();
                } else {
                    // Late or never: failed/timed-out outcome, no decoded result.
                    expect(outcome.ok).toBe(false);
                    expect(outcome.timedOut).toBe(true);
                    expect(outcome.result).toBeUndefined();
                }
            }),
            { numRuns: 100 }
        );
    });

    test("a malformed or truncated in-time reply is reported, never decoded (Req 2.15)", async () => {
        await fc.assert(
            fc.asyncProperty(
                malformedPayloadArb,
                fc.integer({ min: 1, max: 5000 }),
                async (badHex, timeoutMs) => {
                    // The host answers immediately, so the timeout never wins:
                    // the failure below is the DECODE failure, not a timeout.
                    const iface = {
                        calls: 0,
                        evalScript(script, cb) {
                            this.calls++;
                            setTimeout(function () {
                                cb(badHex);
                            }, 0);
                        },
                    };

                    const pending = callHost("hostCall()", {
                        timeoutMs: timeoutMs,
                        csInterface: iface,
                    });
                    jest.advanceTimersByTime(timeoutMs + 10);
                    const outcome = await pending;

                    expect(iface.calls).toBe(1);
                    expect(outcome.ok).toBe(false);
                    expect(outcome.timedOut).toBeUndefined();
                    // No corrupted string is handed back to the caller.
                    expect(outcome.result).toBeUndefined();
                    expect(typeof outcome.error).toBe("string");
                    expect(outcome.error).toMatch(/Malformed Bridge payload/);
                }
            ),
            { numRuns: 60 }
        );
    });

    test("a well-formed reply of the same length still decodes (the check is not over-eager)", async () => {
        const iface = {
            calls: 0,
            evalScript(script, cb) {
                this.calls++;
                setTimeout(function () {
                    cb(encodeBridge("Hell"));
                }, 0);
            },
        };
        const pending = callHost("hostCall()", { timeoutMs: 500, csInterface: iface });
        jest.advanceTimersByTime(510);
        const outcome = await pending;

        expect(outcome.ok).toBe(true);
        expect(outcome.result).toBe("Hell");
    });
});
