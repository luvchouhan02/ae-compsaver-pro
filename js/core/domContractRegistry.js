/* DOM compatibility map, verification matrix seed, and fail-closed retirement gates. */
(function (root) {
    "use strict";
    var REQUIRED_GATES = ["capability-equivalence", "bridge-equivalence", "accessibility", "package-integrity"];
    var REQUIREMENT_COUNTS = [6, 6, 8, 6, 8, 6, 11, 7, 6, 6, 18, 11, 18, 12, 9, 9, 10, 9, 10, 10, 7, 14, 9];

    function capabilityRegistry() {
        if (root.CompSaverCapabilityRegistry) return root.CompSaverCapabilityRegistry;
        if (typeof require === "function") return require("./capabilityRegistry");
        return null;
    }
    function bridgeRegistry() {
        if (root.CompSaverBridgeRegistry) return root.CompSaverBridgeRegistry;
        if (typeof require === "function") return require("./bridgeRegistry");
        return null;
    }

    var capabilities = capabilityRegistry();
    var bridges = bridgeRegistry();
    var contracts = [];
    var verificationMatrix = [];

    function matrixRecord(id, requirementId, capabilityId, method, runtime, viewport, rationale) {
        return {
            id: id,
            requirementId: requirementId,
            capabilityId: capabilityId,
            verificationMethod: method,
            runtime: runtime,
            viewport: viewport,
            status: "PENDING",
            evidenceLocation: "pending://" + id,
            rationale: rationale
        };
    }
    if (capabilities) capabilities.capabilities.forEach(function (capability) {
        var contractId = "dom." + capability.id;
        contracts.push({
            id: contractId,
            capabilityId: capability.id,
            oldSelector: capability.legacyBinding.selector,
            oldEvent: capability.legacyBinding.event,
            semanticAction: capability.id,
            newSelector: null,
            browserHandler: capability.browserHandler,
            bridgeIds: capability.bridgeIds.slice(0),
            rollback: { active: true, surface: "legacy." + capability.module },
            temporaryAlias: {
                required: true,
                status: "RETAINED",
                removalPrerequisites: REQUIRED_GATES.slice(0),
                removalDecision: "BLOCKED_REPLACEMENT_NOT_REGISTERED",
                removedAt: null
            }
        });
        verificationMatrix.push(matrixRecord(
            "workflow." + capability.id,
            capability.requirementIds[0] || "2.1",
            capability.id,
            "capability-baseline-equivalence",
            capability.bridgeIds.length ? "CEP+After Effects" : "CEP browser",
            "all-supported",
            "Baseline action remains pre-release until host/disk/persistence/user-visible equivalence is evidenced."
        ));
        capability.bridgeIds.forEach(function (bridgeId) {
            verificationMatrix.push(matrixRecord(
                "bridge." + capability.id + "." + bridgeId,
                "3.1",
                capability.id,
                "bridge-contract-equivalence",
                "CEP+ExtendScript",
                "not-applicable",
                "Compare identity, arguments, representation, codec, callback, decoder, sentinels, timeout, and late response behavior."
            ));
        });
    });

    REQUIREMENT_COUNTS.forEach(function (count, index) {
        var requirement = index + 1;
        for (var criterion = 1; criterion <= count; criterion++) {
            var id = requirement + "." + criterion;
            verificationMatrix.push(matrixRecord(
                "requirement." + id,
                id,
                null,
                "acceptance-criterion",
                "as-specified",
                "as-specified",
                "Seed record guarantees criterion traceability; release evidence replaces the pending location and status."
            ));
        }
    });
    function byCapabilityId(capabilityId) {
        for (var i = 0; i < contracts.length; i++) if (contracts[i].capabilityId === capabilityId) return contracts[i];
        return null;
    }
    function latestGateStatuses(capabilityId, records) {
        var statuses = {};
        REQUIRED_GATES.forEach(function (gate) { statuses[gate] = "MISSING"; });
        (records || []).forEach(function (record) {
            if (record && record.capabilityId === capabilityId && statuses.hasOwnProperty(record.verificationMethod)) {
                statuses[record.verificationMethod] = record.status;
            }
        });
        return statuses;
    }
    function evaluateRetirement(capabilityId, evidenceRecords, cleanupComplete) {
        var contract = byCapabilityId(capabilityId);
        var blockers = [];
        if (!contract) return { allowed: false, blockers: ["UNKNOWN_CAPABILITY"] };
        if (!contract.newSelector) blockers.push("REPLACEMENT_NOT_REGISTERED");
        var statuses = latestGateStatuses(capabilityId, evidenceRecords);
        REQUIRED_GATES.forEach(function (gate) { if (statuses[gate] !== "PASS") blockers.push("GATE_NOT_PASSING:" + gate); });
        if (cleanupComplete !== true) blockers.push("OBSOLETE_CLEANUP_INCOMPLETE");
        return {
            allowed: blockers.length === 0,
            blockers: blockers,
            aliasAction: blockers.length === 0 ? "REMOVE" : "RETAIN",
            rollbackAction: blockers.length === 0 ? "MAY_DEACTIVATE_AFTER_CLEANUP" : "KEEP_ACTIVE",
            gateStatuses: statuses
        };
    }

    function validate() {
        var errors = [], ids = {}, capIds = {};
        if (!capabilities || !bridges) errors.push("registry-dependency-missing");
        contracts.forEach(function (contract, index) {
            var p = "dom[" + index + "]";
            if (ids[contract.id]) errors.push(p + ":duplicate-id"); else ids[contract.id] = true;
            if (capIds[contract.capabilityId]) errors.push(p + ":duplicate-capability"); else capIds[contract.capabilityId] = true;
            if (!capabilities || !capabilities.byId(contract.capabilityId)) errors.push(p + ":unknown-capability");
            ["oldSelector", "oldEvent", "semanticAction", "browserHandler"].forEach(function (key) { if (!contract[key]) errors.push(p + ":missing-" + key); });
            contract.bridgeIds.forEach(function (id) { if (!bridges || !bridges.byId(id)) errors.push(p + ":unknown-bridge:" + id); });
            if (!contract.rollback.active || contract.temporaryAlias.status !== "RETAINED") errors.push(p + ":unsafe-initial-retirement-state");
        });
        verificationMatrix.forEach(function (record, index) {
            var p = "matrix[" + index + "]";
            ["id", "requirementId", "verificationMethod", "runtime", "viewport", "status", "evidenceLocation", "rationale"].forEach(function (key) {
                if (!record[key]) errors.push(p + ":missing-" + key);
            });
        });
        return { ok: errors.length === 0, errors: errors };
    }
    var api = {
        schemaVersion: "1.0.0",
        requiredRetirementGates: REQUIRED_GATES,
        contracts: contracts,
        verificationMatrix: verificationMatrix,
        byCapabilityId: byCapabilityId,
        evaluateRetirement: evaluateRetirement,
        validate: validate
    };
    if (typeof Object.freeze === "function") {
        Object.freeze(REQUIRED_GATES); Object.freeze(contracts); Object.freeze(verificationMatrix); Object.freeze(api);
    }
    root.CompSaverDomContractRegistry = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof window !== "undefined" ? window : this));
