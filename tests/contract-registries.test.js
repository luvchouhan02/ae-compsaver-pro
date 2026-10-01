const fs = require("fs");
const path = require("path");
const Bridge = require("../js/core/bridgeRegistry");
const Capability = require("../js/core/capabilityRegistry");
const Dom = require("../js/core/domContractRegistry");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("executable baseline registries", () => {
    test("all schemas and cross-registry discriminators validate", () => {
        expect(Bridge.validate(Bridge.contracts)).toEqual({ ok: true, errors: [] });
        expect(Capability.validate(Capability.capabilities, Bridge)).toEqual({ ok: true, errors: [] });
        expect(Dom.validate()).toEqual({ ok: true, errors: [] });
        expect(Bridge.schemaVersion).toBe("1.0.0");
        expect(Capability.schemaVersion).toBe("1.0.0");
        expect(Dom.schemaVersion).toBe("1.0.0");
    });

    test("every capability has one DOM contract and one workflow matrix record", () => {
        expect(Capability.capabilities.length).toBeGreaterThan(100);
        expect(Dom.contracts).toHaveLength(Capability.capabilities.length);
        for (const capability of Capability.capabilities) {
            expect(Dom.byCapabilityId(capability.id)).not.toBeNull();
            expect(Dom.verificationMatrix.some((r) => r.id === `workflow.${capability.id}`)).toBe(true);
        }
    });

    test("every acceptance criterion has an explicit traceability seed", () => {
        const expectedCounts = [6, 6, 8, 6, 8, 6, 11, 7, 6, 6, 18, 11, 18, 12, 9, 9, 10, 9, 10, 10, 7, 14, 9];
        const expected = expectedCounts.reduce((sum, count) => sum + count, 0);
        const records = Dom.verificationMatrix.filter((r) => r.id.startsWith("requirement."));
        expect(records).toHaveLength(expected);
        expectedCounts.forEach((count, index) => {
            for (let criterion = 1; criterion <= count; criterion++) {
                expect(records.some((r) => r.requirementId === `${index + 1}.${criterion}`)).toBe(true);
            }
        });
    });
});
describe("bridge compatibility details", () => {
    test("guarded saves retain codec, timeout, non-rejection, and late suppression", () => {
        const save = Bridge.byId("templates.save.comp");
        expect(save.hostFunction).toBe("saveActiveComp");
        expect(save.argumentOrder).toEqual(["name", "category", "rootPath", "oldId"]);
        expect(save.argumentRepresentations).toEqual(["hex-utf16", "hex-utf16", "hex-utf16", "hex-utf16"]);
        expect(save.timeoutPolicy).toEqual(expect.objectContaining({
            policy: "guarded", milliseconds: 30000, nonRejecting: true, lateResponseSuppression: true
        }));
        expect(save.failureSentinels).toEqual(expect.arrayContaining(["", "EvalScript error.", "undefined", "timeout"]));
    });

    test("the existence probe declares the envelope, the section argument, and the guarded transport", () => {
        const probe = Bridge.byId("templates.item-exists");
        expect(probe.hostFunction).toBe("itemExists");
        // The fourth argument is the section actually being saved; without it the
        // host defaulted to "comp" and answered for the wrong section.
        expect(probe.argumentOrder).toEqual(["name", "category", "rootPath", "section"]);
        expect(probe.argumentRepresentations).toEqual(["hex-utf16", "hex-utf16", "hex-utf16", "hex-utf16"]);
        // The reply is an explicit envelope, never the boolean protocol the panel
        // used to compare against (the host answered with a folder NAME).
        expect(probe.decoder).toBe("decodeBridge+json-object");
        expect(probe.successShapes).toEqual(["{exists:Boolean,id?:String,section:String}"]);
        expect(probe.successShapes).not.toContain("true");
        expect(probe.successShapes).not.toContain("false");
        // Same guarded transport the saves use: bounded, non-rejecting, first
        // settlement wins.
        expect(probe.transportPolicy).toBe("guarded-callHost");
        expect(probe.callbackBehavior).toBe("promise-never-rejects-first-settlement-wins");
        expect(probe.timeoutPolicy).toEqual(expect.objectContaining({
            policy: "guarded", milliseconds: 30000, nonRejecting: true, lateResponseSuppression: true
        }));
    });

    test("raw, encoded, numeric, JSON, and inline-expression contracts remain distinct", () => {
        expect(Bridge.byId("easing.apply").argumentRepresentations).toEqual(["raw-number", "raw-number"]);
        expect(Bridge.byId("colorflow.apply").argumentRepresentations).toEqual(["hex-utf16", "hex-utf16"]);
        expect(Bridge.byId("toolkit.crop-precomp").argumentRepresentations).toEqual(["raw-boolean"]);
        expect(Bridge.byId("effects.validate-selection").decoder).toBe("raw-status");
        expect(Bridge.byId("effects.save").inlineExpressionId).toBe("effects.rename-save-restore-v1");
        expect(Bridge.byId("global.comp-monitor").decoder).toBe("decodeBridge-applied-to-raw-baseline");
        expect(Bridge.byId("text.apply").decoder).toBe("decodeBridge+json-object");
    });

    test("source named evalScript calls are represented or explicitly wrapped inline", () => {
        const files = [
            "js/templates/templates.js", "js/toolkit/toolkit.js", "js/toolkit/effects.js",
            "js/toolkit/flow.js", "js/toolkit/colorflow.js", "js/textanim/textanim.js",
            "js/ui/settings-panel.js", "js/ui/paste.js", "js/ui/comp-monitor.js", "js/main.js"
        ];
        const source = files.map(read).join("\n");
        const direct = new Set();
        const re = /evalScript\(\s*["'`]([A-Za-z_$][\w$]*)\s*\(/g;
        let match;
        while ((match = re.exec(source)) !== null) direct.add(match[1]);
        const registered = new Set(Bridge.contracts.map((c) => c.hostFunction).filter(Boolean));
        const inlineWrappers = new Set(["encodeBridge"]);
        const uncovered = [...direct].filter((name) => !registered.has(name) && !inlineWrappers.has(name));
        expect(uncovered).toEqual([]);
    });
});
describe("legacy retirement is fail closed", () => {
    const passingEvidence = (capabilityId) => Dom.requiredRetirementGates.map((gate) => ({
        capabilityId,
        verificationMethod: gate,
        status: "PASS"
    }));

    test("missing evidence retains aliases and rollback", () => {
        const result = Dom.evaluateRetirement("templates.save.comp", [], false);
        expect(result.allowed).toBe(false);
        expect(result.aliasAction).toBe("RETAIN");
        expect(result.rollbackAction).toBe("KEEP_ACTIVE");
        expect(result.blockers).toEqual(expect.arrayContaining([
            "REPLACEMENT_NOT_REGISTERED",
            "GATE_NOT_PASSING:capability-equivalence",
            "GATE_NOT_PASSING:bridge-equivalence",
            "GATE_NOT_PASSING:accessibility",
            "GATE_NOT_PASSING:package-integrity",
            "OBSOLETE_CLEANUP_INCOMPLETE"
        ]));
    });

    test("even all passing evidence cannot remove an unregistered replacement", () => {
        const result = Dom.evaluateRetirement(
            "templates.save.comp",
            passingEvidence("templates.save.comp"),
            true
        );
        expect(result.allowed).toBe(false);
        expect(result.blockers).toEqual(["REPLACEMENT_NOT_REGISTERED"]);
    });

    test("unknown capabilities and unknown bridge references fail closed", () => {
        expect(Dom.evaluateRetirement("not-a-capability", passingEvidence("not-a-capability"), true))
            .toEqual({ allowed: false, blockers: ["UNKNOWN_CAPABILITY"] });
        const invalid = Capability.capabilities.concat([{
            id: "invalid", module: "x", kind: "action", browserHandler: "x",
            legacyBinding: { selector: "#x", event: "click" }, bridgeIds: ["missing"], requirementIds: ["2.1"]
        }]);
        expect(Capability.validate(invalid, Bridge).errors).toContain(
            `capability[${invalid.length - 1}]:unknown-bridge:missing`
        );
    });

    test("all initial aliases remain retained behind active rollback", () => {
        expect(Dom.contracts.every((c) =>
            c.rollback.active === true &&
            c.temporaryAlias.status === "RETAINED" &&
            c.temporaryAlias.removalPrerequisites.length === 4
        )).toBe(true);
    });
});
