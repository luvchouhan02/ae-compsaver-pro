/**
 * ToolBridge timeout-policy accuracy for Toolkit bridge contracts.
 *
 * Every Toolkit bridge call now goes through `ToolBridge.call` (js/core/
 * toolBridge.js), which bounds the call with a timer, funnels success / host
 * error / timeout / disposal through ONE finalizer, never rejects, and drops a
 * late or duplicate evalScript callback via its `record.done` latch.
 *
 * The bridge-contract registry, however, still described those calls with
 * `DIRECT_TIMEOUT` — `{ policy: "none", milliseconds: null, nonRejecting: false,
 * lateResponseSuppression: false }` — i.e. "unbounded, may reject, late replies
 * land". That made the registry actively misleading about the Toolkit's failure
 * behaviour. The contracts now declare `policy: "tool-bridge"` with the real
 * bound.
 *
 * This test derives the truth from the SOURCES, not from a hardcoded list:
 *   - the set of ToolBridge-dispatched host functions is parsed out of the
 *     `ToolBridge.call({ … script: '<hostFn>(' … })` call sites;
 *   - the default bound is parsed out of toolBridge.js's DEFAULT_TIMEOUT_MS;
 *   - each call site's explicit `timeoutMs:` override is parsed too.
 * So the registry has to keep matching the call sites as they change.
 */

const fs = require("fs");
const path = require("path");
const Bridge = require("../js/core/bridgeRegistry");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Every file that dispatches Toolkit work through ToolBridge.
const TOOL_BRIDGE_SOURCES = [
    "js/toolkit/toolkit.js",
    "js/toolkit/effects.js",
    "js/toolkit/flow.js",
    "js/toolkit/colorflow.js",
    "js/ui/paste.js"
];

// ── Parse ToolBridge's own default bound ───────────────────────────────────────

const toolBridgeSrc = read("js/core/toolBridge.js");
const defaultMatch = toolBridgeSrc.match(/DEFAULT_TIMEOUT_MS\s*=\s*(\d+)/);
const DEFAULT_TIMEOUT_MS = defaultMatch ? Number(defaultMatch[1]) : NaN;

// ── Parse every ToolBridge.call site ──────────────────────────────────────────

/**
 * Extract one record per `ToolBridge.call({ … })` site:
 *   { file, key, timeoutMs|null, hostFunction|null }
 * `hostFunction` is null when the script is passed as a pre-built variable
 * (the inline-expression contracts) — those are resolved separately below.
 */
function parseCallSites(rel) {
    const src = read(rel);
    const sites = [];
    const re = /ToolBridge\.call\(\{/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        // A generous window: the options object plus its onResult body. Only the
        // leading option lines are inspected, so overshooting is harmless as
        // long as we stop before the NEXT call site.
        const nextIdx = src.indexOf("ToolBridge.call({", m.index + 1);
        const end = nextIdx === -1 ? src.length : nextIdx;
        const block = src.slice(m.index, end);

        const keyMatch = block.match(/key:\s*"([^"]+)"/);
        const timeoutMatch = block.match(/timeoutMs:\s*(\d+)/);
        // `script: 'hostFn(' + …` or `script: "hostFn()"`.
        const scriptMatch = block.match(/script:\s*["']([A-Za-z_$][\w$]*)\s*\(/);

        sites.push({
            file: rel,
            key: keyMatch ? keyMatch[1] : null,
            timeoutMs: timeoutMatch ? Number(timeoutMatch[1]) : null,
            hostFunction: scriptMatch ? scriptMatch[1] : null
        });
    }
    return sites;
}

const CALL_SITES = TOOL_BRIDGE_SOURCES.reduce(
    (all, rel) => all.concat(parseCallSites(rel)),
    []
);

/**
 * `runToolkitAction` builds its script into a `jsx` variable and dispatches it
 * through a single `ToolBridge.call({ key: "toolkit." + action, script: jsx })`.
 * So the host functions that site can reach are the ones assigned to `jsx`,
 * parsed out of the dispatch ladder. This keeps the whole workbench (anchor,
 * align, create, precompose, decompose, guides, …) derived rather than listed.
 */
function parseRunToolkitActionHostFunctions() {
    const src = read("js/toolkit/toolkit.js");
    const start = src.indexOf("function runToolkitAction(");
    if (start === -1) return new Set();
    const end = src.indexOf("\n}", start);
    const body = src.slice(start, end === -1 ? src.length : end);
    const names = new Set();
    const re = /jsx\s*=\s*["']([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(body)) !== null) names.add(m[1]);
    return names;
}

const RUN_ACTION_HOST_FUNCTIONS = parseRunToolkitActionHostFunctions();

/**
 * Call sites whose `script:` is a variable rather than a literal, mapped to the
 * registry contract they dispatch. These are the inline-expression contracts and
 * the `runToolkitAction` ladder — the script text is assembled above the call, so
 * it cannot be parsed from the `script:` line. Kept explicit (and asserted to
 * stay resolvable) instead of silently skipped.
 *
 * Keys are matched by prefix because `runToolkitAction` composes its key as
 * `"toolkit." + action`, so the literal in the source is just `"toolkit."`.
 */
const INLINE_KEY_TO_CONTRACT = {
    "effects.save": "effects.validate-selection",   // selection preflight
    "effects.save-preset": "effects.save",          // rename → save → restore
    "effects.apply": null,                          // apply-ffx OR apply-custom
    "toolkit.": null                                // runToolkitAction ladder
};

const INLINE_APPLY_CONTRACTS = ["effects.apply-ffx", "effects.apply-custom"];

/** All registry contracts reached from a ToolBridge call site. */
function boundContractIds() {
    const ids = new Set();
    const addByHostFunction = (name) => {
        Bridge.contracts
            .filter((c) => c.hostFunction === name)
            .forEach((c) => ids.add(c.id));
    };
    for (const site of CALL_SITES) {
        if (site.hostFunction) {
            addByHostFunction(site.hostFunction);
            continue;
        }
        if (site.key === "toolkit.") {
            RUN_ACTION_HOST_FUNCTIONS.forEach(addByHostFunction);
            continue;
        }
        if (site.key === "effects.apply") {
            INLINE_APPLY_CONTRACTS.forEach((id) => ids.add(id));
            continue;
        }
        const mapped = INLINE_KEY_TO_CONTRACT[site.key];
        if (mapped) ids.add(mapped);
    }
    return ids;
}

const BOUND_IDS = boundContractIds();

function isBoundedToolBridgePolicy(policy) {
    return !!policy &&
        policy.policy === "tool-bridge" &&
        typeof policy.milliseconds === "number" &&
        isFinite(policy.milliseconds) &&
        policy.milliseconds > 0 &&
        policy.nonRejecting === true &&
        policy.lateResponseSuppression === true;
}

// ── Sanity: the derivation actually found the call sites ──────────────────────

describe("ToolBridge call-site derivation", () => {
    test("toolBridge.js exposes a numeric default bound", () => {
        expect(Number.isFinite(DEFAULT_TIMEOUT_MS)).toBe(true);
        expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    });

    test("every Toolkit source with ToolBridge calls yields parsed sites", () => {
        expect(CALL_SITES.length).toBeGreaterThanOrEqual(8);
        expect(CALL_SITES.every((s) => !!s.key)).toBe(true);
    });

    test("every call site resolves to at least one registry contract", () => {
        const unresolved = CALL_SITES.filter((site) => {
            if (site.hostFunction) {
                return !Bridge.contracts.some((c) => c.hostFunction === site.hostFunction);
            }
            if (site.key === "effects.apply") return false;
            return !Object.prototype.hasOwnProperty.call(INLINE_KEY_TO_CONTRACT, site.key);
        }).map((s) => `${s.file} key=${s.key} script=${s.hostFunction || "(variable)"}`);
        expect(unresolved).toEqual([]);
    });

    test("the runToolkitAction dispatch ladder was parsed", () => {
        // anchor, align, create ×2, organize, effects, precompose, unprecompose,
        // cache, multiprecomp, sequence, truedup, decompose, resize, bounce,
        // guides-on, guides-off, delete-expression → 17 distinct host functions.
        expect(RUN_ACTION_HOST_FUNCTIONS.size).toBeGreaterThanOrEqual(15);
        expect(RUN_ACTION_HOST_FUNCTIONS.has("toolkitAnchorPoint")).toBe(true);
        expect(RUN_ACTION_HOST_FUNCTIONS.has("toolkitDeCompose")).toBe(true);
    });

    test("the derived bound-contract set covers the Toolkit surface", () => {
        // anchor/align/create/precompose/… + crop + preflight + flow + colorflow
        // + paste ×2 + effects ×4 — comfortably more than 20 contracts.
        expect(BOUND_IDS.size).toBeGreaterThanOrEqual(20);
        expect(BOUND_IDS.has("toolkit.crop-precomp")).toBe(true);
        expect(BOUND_IDS.has("toolkit.anchor")).toBe(true);
        expect(BOUND_IDS.has("easing.apply")).toBe(true);
        expect(BOUND_IDS.has("colorflow.apply")).toBe(true);
        expect(BOUND_IDS.has("paste.import-clipboard")).toBe(true);
    });
});

// ── The contract must describe the real (bounded) behaviour ──────────────────

describe("Toolkit contracts declare a bounded tool-bridge timeout policy", () => {
    test("no ToolBridge-dispatched contract still claims an unbounded policy", () => {
        const unbounded = [...BOUND_IDS]
            .map((id) => Bridge.byId(id))
            .filter((c) => c && c.timeoutPolicy && c.timeoutPolicy.policy === "none")
            .map((c) => c.id);
        expect(unbounded).toEqual([]);
    });

    test.each([...BOUND_IDS].sort())(
        "%s declares policy tool-bridge, non-rejecting, late-suppressed, finite bound",
        (id) => {
            const contract = Bridge.byId(id);
            expect(contract).not.toBeNull();
            expect(isBoundedToolBridgePolicy(contract.timeoutPolicy)).toBe(true);
        }
    );

    test("bounded contracts advertise ToolBridge's single-finalizer callback behaviour", () => {
        const wrong = [...BOUND_IDS]
            .map((id) => Bridge.byId(id))
            .filter((c) => c.callbackBehavior !== "single-finalizer-late-suppressed")
            .map((c) => `${c.id} → ${c.callbackBehavior}`);
        expect(wrong).toEqual([]);
    });
});

// ── The declared bound must equal the call site's actual bound ────────────────

describe("declared milliseconds match the dispatching call site", () => {
    // Call sites with a literal host function are the ones whose bound can be
    // attributed unambiguously to a specific contract.
    const attributable = CALL_SITES.filter((s) => s.hostFunction);

    test("there is at least one overridden and one default-bound call site", () => {
        expect(attributable.some((s) => s.timeoutMs !== null)).toBe(true);
        expect(attributable.some((s) => s.timeoutMs === null)).toBe(true);
    });

    test.each(attributable.map((s) => [s.hostFunction, s.timeoutMs, s.file]))(
        "%s → %s ms (%s)",
        (hostFunction, timeoutMs) => {
            const expected = timeoutMs === null ? DEFAULT_TIMEOUT_MS : timeoutMs;
            const matches = Bridge.contracts.filter((c) => c.hostFunction === hostFunction);
            expect(matches.length).toBeGreaterThan(0);
            for (const contract of matches) {
                expect(contract.timeoutPolicy.milliseconds).toBe(expected);
            }
        }
    );
});

// ── The registry's own validator must reject a counterfeit policy ────────────

describe("registry validation guards the tool-bridge policy shape", () => {
    /** A structurally valid contract with a swappable timeout policy. */
    function contractWithPolicy(timeoutPolicy) {
        return {
            id: "probe.contract",
            hostFunction: "probeHost",
            inlineExpressionId: null,
            transportPolicy: "legacy-callback",
            argumentOrder: [],
            argumentRepresentations: [],
            encoders: [],
            decoder: "decodeBridge",
            timeoutPolicy: timeoutPolicy,
            callbackBehavior: "single-finalizer-late-suppressed",
            successShapes: ["true"],
            failureSentinels: [""],
            source: "test"
        };
    }

    test("a well-formed tool-bridge policy validates", () => {
        const result = Bridge.validate([contractWithPolicy({
            policy: "tool-bridge", milliseconds: 30000,
            nonRejecting: true, lateResponseSuppression: true
        })]);
        expect(result).toEqual({ ok: true, errors: [] });
    });

    test.each([
        ["null bound", { policy: "tool-bridge", milliseconds: null, nonRejecting: true, lateResponseSuppression: true }],
        ["zero bound", { policy: "tool-bridge", milliseconds: 0, nonRejecting: true, lateResponseSuppression: true }],
        ["infinite bound", { policy: "tool-bridge", milliseconds: Infinity, nonRejecting: true, lateResponseSuppression: true }],
        ["rejecting", { policy: "tool-bridge", milliseconds: 30000, nonRejecting: false, lateResponseSuppression: true }],
        ["late replies land", { policy: "tool-bridge", milliseconds: 30000, nonRejecting: true, lateResponseSuppression: false }]
    ])("a tool-bridge policy that only borrows the name is rejected (%s)", (_label, policy) => {
        const result = Bridge.validate([contractWithPolicy(policy)]);
        expect(result.ok).toBe(false);
        expect(result.errors).toContain("bridge[0]:tool-bridge-policy-mismatch:probe.contract");
    });

    test("the shipped registry still validates as a whole", () => {
        expect(Bridge.validate(Bridge.contracts)).toEqual({ ok: true, errors: [] });
    });
});
