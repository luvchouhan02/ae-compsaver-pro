"use strict";

/**
 * Phase 0 bug-condition exploration. This intentionally encodes the future
 * phase contract against the unfixed baseline and is expected to fail.
 * It must not be weakened when the counterexamples below are reported.
 *
 * Property 1: Bug Condition — Authorized scenarios must satisfy the measured
 * phase contract.
 *
 * **Validates: Requirements 1.1–1.16, 2.31, 2.33, 2.35, 3.11**
 */

const fs = require("fs");
const path = require("path");
const fc = require("fast-check");

const ROOT = path.resolve(__dirname, "../..");
const REPORT_EVIDENCE = require(path.join(
    ROOT,
    ".kiro/specs/performance-scalability-forensics/evidence/benchmark-results.json"
));

const SOURCE = {
    main: fs.readFileSync(path.join(ROOT, "js/main.js"), "utf8"),
    bridge: fs.readFileSync(path.join(ROOT, "js/core/bridge.js"), "utf8"),
    templates: fs.readFileSync(path.join(ROOT, "js/templates/templates.js"), "utf8"),
    persistence: fs.readFileSync(path.join(ROOT, "js/core/persistence.js"), "utf8"),
    fastMedia: fs.readFileSync(path.join(ROOT, "js/core/fastMediaEngine.js"), "utf8"),
};

const FIXTURE_COUNTS = [150, 1000, 2000, 5000];
const LAUNCH_STATES = ["cold", "warm", "same-session-reopen", "post-restart-reopen"];
const CACHE_STATES = [
    "missing", "valid", "stale", "corrupt", "rebuilt", "reconciled",
    "incremental-update", "partial-change",
];
const PAYLOAD_BOUNDARIES = [49151, 49152, 49153, 1703922];
const ROOT_MUTATIONS = ["nested-meta-edit", "nested-media-edit", "root-cache-write"];
const MEDIA_BATCHES = [1, 2, 10, 100];
const FAILURE_POINTS = ["none", "copy", "thumbnail", "proxy", "timeout", "cancel", "unload", "late-callback"];

const MANIFESTATIONS = [
    "duplicate-or-unowned-resource",
    "false-failure-undefined-tMeta",
    "legacy-large-transport",
    "unchanged-full-library-query",
    "unchanged-full-grid-update",
    "nested-root-change-miss",
    "cache-write-invalidates-source",
    "unbounded-ambiguous-media-terminal",
];

function operationOwnsDuplicateOrUndisposedResource(input) {
    return input.operation === "duplicate-or-unowned-resource";
}

function fastMediaSuccessFallsThroughToFalseFailure(input) {
    return input.operation === "false-failure-undefined-tMeta";
}

function legacyHexTransportWouldBeUsed(input) {
    return input.transport === "legacy-hex";
}

function repositoryQueryOrGridUpdateTouchesUnchangedFullLibrary(input) {
    return input.operation === "unchanged-full-library-query" ||
        input.operation === "unchanged-full-grid-update";
}

function nestedRootChangeIsMissedOrCacheWriteInvalidatesSource(input) {
    return input.operation === "nested-root-change-miss" ||
        input.operation === "cache-write-invalidates-source";
}

function mediaWorkHasNoBoundedLaneAtomicCommitOrTerminalOwner(input) {
    return input.operation === "unbounded-ambiguous-media-terminal" &&
        (!input.mediaLaneBounded || !input.mediaCommitAtomic || !input.mediaHasTerminalOwner);
}

// This is the design's formal predicate, transcribed without broadening "large"
// or "slow" into bug conditions of their own.
function isBugCondition(input) {
    if (!input.approved) return false;
    return (
        (input.phase === 1 && operationOwnsDuplicateOrUndisposedResource(input)) ||
        (input.phase === 1 && fastMediaSuccessFallsThroughToFalseFailure(input)) ||
        (input.phase === 2 && input.payloadBytes >= input.negotiatedInlineLimit &&
            legacyHexTransportWouldBeUsed(input)) ||
        (input.phase === 3 && repositoryQueryOrGridUpdateTouchesUnchangedFullLibrary(input)) ||
        (input.phase === 4 && nestedRootChangeIsMissedOrCacheWriteInvalidatesSource(input)) ||
        (input.phase === 4 && mediaWorkHasNoBoundedLaneAtomicCommitOrTerminalOwner(input))
    );
}

function expectedBehavior(result) {
    return result.phaseWasAuthorized &&
        result.preservationSuitePassed &&
        result.numericGatePassed &&
        result.requiredEvidenceIsComplete &&
        result.hasNoUnauthorizedFileOrFunctionChanges &&
        result.rollbackWasExercisedSuccessfully;
}

function phaseFor(operation) {
    if (operation === MANIFESTATIONS[0] || operation === MANIFESTATIONS[1]) return 1;
    if (operation === MANIFESTATIONS[2]) return 2;
    if (operation === MANIFESTATIONS[3] || operation === MANIFESTATIONS[4]) return 3;
    return 4;
}

function buildScenarioMatrix() {
    return Array.from({ length: 64 }, function (_, index) {
        const operation = MANIFESTATIONS[index % MANIFESTATIONS.length];
        return {
            id: "phase-0-generated-" + String(index).padStart(2, "0"),
            approved: true,
            phase: phaseFor(operation),
            operation: operation,
            fixtureCount: FIXTURE_COUNTS[index % FIXTURE_COUNTS.length],
            launchState: LAUNCH_STATES[Math.floor(index / 4) % LAUNCH_STATES.length],
            rootState: CACHE_STATES[index % CACHE_STATES.length],
            cacheState: CACHE_STATES[index % CACHE_STATES.length],
            payloadBytes: PAYLOAD_BOUNDARIES[Math.floor(index / 2) % PAYLOAD_BOUNDARIES.length],
            negotiatedInlineLimit: 49152,
            transport: "legacy-hex",
            rootMutation: ROOT_MUTATIONS[Math.floor(index / 3) % ROOT_MUTATIONS.length],
            mediaBatch: MEDIA_BATCHES[Math.floor(index / 5) % MEDIA_BATCHES.length],
            failureInjection: FAILURE_POINTS[index % FAILURE_POINTS.length],
            mediaLaneBounded: false,
            mediaCommitAtomic: false,
            mediaHasTerminalOwner: false,
        };
    });
}

const SCENARIOS = buildScenarioMatrix();

function valuesOf(key) {
    return new Set(SCENARIOS.map(function (scenario) { return scenario[key]; }));
}

function measurement(name, count) {
    const found = REPORT_EVIDENCE.results.find(function (entry) {
        return entry.name === name && entry.count === count;
    });
    if (!found) throw new Error("Missing forensic measurement: " + name + " @ " + count);
    return found;
}

function manifest(count) {
    const found = REPORT_EVIDENCE.manifests.find(function (entry) {
        return entry.count === count;
    });
    if (!found) throw new Error("Missing forensic fixture manifest: " + count);
    return found;
}

function sourceCount(source, pattern) {
    const matches = source.match(pattern);
    return matches ? matches.length : 0;
}

function commonResult(input, observation, rawMeasurements) {
    return {
        phaseWasAuthorized: true,
        preservationSuitePassed: false,
        numericGatePassed: false,
        requiredEvidenceIsComplete: false,
        hasNoUnauthorizedFileOrFunctionChanges: true,
        rollbackWasExercisedSuccessfully: false,
        observation: observation,
        rawMeasurements: rawMeasurements,
        evidenceBoundary: REPORT_EVIDENCE.scope,
        input: input,
    };
}

function observeDuplicateOrUnowned(input) {
    return commonResult(input, {
        duplicateEffectsLoadCalls: sourceCount(SOURCE.main, /loadSavedEffects\(\);/g),
        duplicateInitialModuleSwitch: SOURCE.main.includes("switchMainModule(currentMainModule)") &&
            SOURCE.main.includes("switchMainModule(startModule)"),
        resizeObserverRetainedForDisposal: SOURCE.main.includes("ro.disconnect"),
        settingsUnsubscribeRetained: /var\s+\w+\s*=\s*Settings\.onChange/.test(SOURCE.main),
        classification: "source-proven contributor; interactive runtime cost unavailable",
    }, {
        startupTimeline: "unavailable: no AE/CEP/CEF runtime was launched",
        reportSource: "forensic-report.md#startup-and-reopen-forensics",
    });
}

function observeUndefinedTMeta(input) {
    const processStart = SOURCE.fastMedia.indexOf("async function processBackgroundCopy");
    const processEnd = SOURCE.fastMedia.indexOf("function extractVideoFrame", processStart);
    const body = SOURCE.fastMedia.slice(processStart, processEnd);
    return commonResult(input, {
        apparentSuccessMutationsPrecedeFailure: body.indexOf("meta._isPending = false") <
            body.indexOf("tCache - tMeta"),
        undefinedTMetaReferenced: body.includes("tCache - tMeta") &&
            !/\b(?:var|let|const)\s+tMeta\b/.test(body),
        failureHandlerReachedAfterThrow: body.includes("showToast(\"Failed to copy \" + fileName, \"error\")"),
        classification: "confirmed source cause of false failure/partial-success ambiguity",
    }, {
        mediaRuntime: "unavailable; deterministic ReferenceError follows from source",
        reportSource: "forensic-report.md#fast-media-thumbnails-metadata-and-ffmpeg",
    });
}

function observeLegacyTransport(input) {
    const fixture = manifest(5000);
    const decode = measurement("decodeBridge(JSON fixture)", 5000);
    const parse = measurement("JSON.parse(JSON fixture)", 5000);
    const combined = measurement("decodeBridge+JSON.parse(JSON fixture)", 5000);
    return commonResult(input, {
        utf8Bytes: fixture.payload.utf8Bytes,
        legacyHexCharacters: fixture.payload.encodedHexCharacters,
        representationRatio: fixture.payload.encodedHexCharacters / fixture.payload.utf8Bytes,
        combinedP95Ms: combined.p95,
        phase2ClientCodecGateMs: 50,
        classification: "confirmed measured pure-code cause within Node boundary",
    }, { fixture: fixture, decode: decode, jsonParse: parse, decodeAndParse: combined });
}

function observeFullLibraryAndGrid(input) {
    return commonResult(input, {
        fullSectionScanPresent: SOURCE.templates.includes("for (var i = 0; i < section.length; i++)"),
        fullGridReplacementPresent: SOURCE.templates.includes("grid.innerHTML = html.join(\"\")"),
        unchangedLibraryTouched: true,
        boundedLiveCardContractSatisfied: false,
        classification: "confirmed source cause; pure string boundary measured, DOM cost unavailable",
    }, {
        allCards: measurement("filterAndRender-all-render-string-only", 5000),
        commonSearch: measurement("filterAndRender-common-search-render-string-only", 5000),
        missSearch: measurement("filterAndRender-miss-search-render-string-only", 5000),
    });
}

function observeRootInvalidation(input) {
    return commonResult(input, {
        validityReadsDirectChildrenOnly: SOURCE.persistence.includes("names = fs.readdirSync(dir)") &&
            SOURCE.persistence.includes("var full = dir + \"/\" + names[i]"),
        recursiveDescentPresent: /readdirSync\(full\)/.test(SOURCE.persistence),
        rootCacheWrittenInsideSource: SOURCE.persistence.includes("/.compsaver_metadata.json"),
        cacheFileParticipatesInRootKey: true,
        nestedMutationCanRetainSameRootKey: true,
        classification: "confirmed source invalidation flaw",
    }, {
        pathologicalDirectEntryBoundary: measurement("deriveFolderValidityKey-direct-entries", 5000),
        qualification: "direct-entry count, not a 5,000-template startup estimate",
        nestedRuntimeTiming: "unavailable; shallow observation follows from source",
    });
}

function observeMediaOwnership(input) {
    return commonResult(input, {
        staggeredSchedulingWithoutSharedQueue: SOURCE.fastMedia.includes("processNext(index + 1)") &&
            SOURCE.fastMedia.includes("}, 100)"),
        ffmpegChildHandlesRetained: /var\s+\w+\s*=\s*cp\.execFile/.test(SOURCE.fastMedia),
        explicitCancelOrUnloadCoordinator: /cancelMedia|disposeFastMedia|abortMedia/.test(SOURCE.fastMedia),
        atomicCommitPresent: /atomic|staging|compareAndSet/i.test(SOURCE.fastMedia),
        exactlyOneTerminalOwner: false,
        partialSuccessFalseFailure: SOURCE.fastMedia.includes("tCache - tMeta"),
        classification: "source-proven unbounded work and ambiguous terminal ownership",
    }, {
        mediaRuntime: "unavailable: no FFmpeg/media scenario was executed",
        sourceMarkers: {
            copyDelayMs: 50,
            folderStaggerMs: 100,
            ffmpegThumbnailTimeoutMs: 10000,
            ffmpegProxyTimeoutMs: 60000,
        },
        reportSource: "forensic-report.md#fast-media-thumbnails-metadata-and-ffmpeg",
    });
}

function observationFor(input) {
    switch (input.operation) {
        case "duplicate-or-unowned-resource": return observeDuplicateOrUnowned(input);
        case "false-failure-undefined-tMeta": return observeUndefinedTMeta(input);
        case "legacy-large-transport": return observeLegacyTransport(input);
        case "unchanged-full-library-query":
        case "unchanged-full-grid-update": return observeFullLibraryAndGrid(input);
        case "nested-root-change-miss":
        case "cache-write-invalidates-source": return observeRootInvalidation(input);
        case "unbounded-ambiguous-media-terminal": return observeMediaOwnership(input);
        default: throw new Error("Unknown generated operation: " + input.operation);
    }
}

function exactCounterexample(operation, overrides) {
    const generated = SCENARIOS.find(function (scenario) {
        return scenario.operation === operation;
    });
    return Object.assign({}, generated, overrides || {}, {
        id: "source-proven-" + operation,
        approved: true,
    });
}

function runExpectedFailureProperty(title, cases, seed) {
    test(title, function () {
        fc.assert(
            fc.property(fc.constantFrom.apply(fc, cases), function (input) {
                if (!isBugCondition(input)) {
                    throw new Error("Generator emitted a non-bug input: " + JSON.stringify(input));
                }
                const result = observationFor(input);
                if (!expectedBehavior(result)) {
                    throw new Error(
                        "PHASE_0_BUG_COUNTEREXAMPLE\n" +
                        JSON.stringify({
                            property: "Property 1: Bug Condition — Authorized scenarios must satisfy the measured phase contract",
                            generatedCounterexample: input,
                            actualPhaseResult: result,
                        }, null, 2)
                    );
                }
            }),
            { seed: seed, numRuns: Math.max(8, cases.length), endOnFailure: true, verbose: 2 }
        );
    });
}

describe("Phase 0 Property 1: authorized scenarios satisfy the measured phase contract", function () {
    test("deterministic approved generator covers every required Phase 0 axis and exact bug predicate boundary", function () {
        expect(valuesOf("fixtureCount")).toEqual(new Set(FIXTURE_COUNTS));
        expect(valuesOf("launchState")).toEqual(new Set(LAUNCH_STATES));
        expect(valuesOf("cacheState")).toEqual(new Set(CACHE_STATES));
        expect(valuesOf("payloadBytes")).toEqual(new Set(PAYLOAD_BOUNDARIES));
        expect(valuesOf("rootMutation")).toEqual(new Set(ROOT_MUTATIONS));
        expect(valuesOf("mediaBatch")).toEqual(new Set(MEDIA_BATCHES));
        expect(valuesOf("failureInjection")).toEqual(new Set(FAILURE_POINTS));
        expect(SCENARIOS.every(isBugCondition)).toBe(true);

        const phase2BelowBoundary = exactCounterexample("legacy-large-transport", {
            phase: 2,
            payloadBytes: 49151,
            negotiatedInlineLimit: 49152,
        });
        expect(isBugCondition(phase2BelowBoundary)).toBe(false);
        expect(isBugCondition(Object.assign({}, SCENARIOS[0], { approved: false }))).toBe(false);
    });

    runExpectedFailureProperty(
        "reproduces duplicate startup work and unowned resource counterexamples",
        SCENARIOS.filter(function (scenario) {
            return scenario.operation === "duplicate-or-unowned-resource";
        }),
        10101
    );

    runExpectedFailureProperty(
        "reproduces successful Fast Media work falling through undefined tMeta",
        SCENARIOS.filter(function (scenario) {
            return scenario.operation === "false-failure-undefined-tMeta";
        }),
        20202
    );

    runExpectedFailureProperty(
        "reproduces the 5,000-record legacy codec numeric-gate counterexample",
        [exactCounterexample("legacy-large-transport", {
            fixtureCount: 5000,
            payloadBytes: 1703922,
            launchState: "cold",
            cacheState: "missing",
            rootState: "missing",
        })],
        30303
    );

    runExpectedFailureProperty(
        "reproduces unchanged full-library scans and full-grid replacement",
        SCENARIOS.filter(function (scenario) {
            return scenario.operation === "unchanged-full-library-query" ||
                scenario.operation === "unchanged-full-grid-update";
        }),
        40404
    );

    runExpectedFailureProperty(
        "reproduces nested-change misses and cache-write invalidation coupling",
        SCENARIOS.filter(function (scenario) {
            return scenario.operation === "nested-root-change-miss" ||
                scenario.operation === "cache-write-invalidates-source";
        }),
        50505
    );

    runExpectedFailureProperty(
        "reproduces unbounded media work and ambiguous terminal ownership",
        SCENARIOS.filter(function (scenario) {
            return scenario.operation === "unbounded-ambiguous-media-terminal";
        }),
        60606
    );
});


/**
 * Phase 0 observation-first preservation freeze. These properties run against
 * the unfixed production functions and copied, temporary fixtures only.
 *
 * Property 2: Preservation — non-bug behavior remains observably equivalent.
 *
 * **Validates: Requirements 3.1–3.11**
 */

const crypto = require("crypto");
const os = require("os");
const vm = require("vm");
const { runReduceFirstSave } = require(path.join(ROOT, "js/core/saveOrchestrator.js"));
const { importTemplates } = require(path.join(ROOT, "js/core/importEngine.js"));
const {
    LibraryIndex,
    MetadataCache,
    LIBRARY_INDEX_VERSION,
    METADATA_CACHE_VERSION,
} = require(path.join(ROOT, "js/core/persistence.js"));
const legacyBridge = require(path.join(ROOT, "js/core/bridge.js"));
const SOURCE_BASELINE = require(path.join(
    ROOT,
    ".kiro/specs/performance-scalability-forensics/evidence/source-baseline.json"
));
const IMPORT_SOURCE = fs.readFileSync(path.join(ROOT, "jsx/import.jsx"), "utf8");

const IMMUTABLE_EVIDENCE = path.join(
    ROOT,
    ".kiro/specs/performance-scalability-forensics/evidence"
);
const MNTOOLS_ROOT = SOURCE_BASELINE.mnTools.root.replace(/\\/g, "/");

// Phase 1 is the only approved production delta from the Phase 0 source
// baseline. Exact hashes keep the original unauthorized-drift protection:
// authorized files must match their reviewed Phase 1 content, every other
// baseline file must still match Phase 0, and no additional file is blessed.
const PHASE_1_AUTHORIZED_HASHES = Object.freeze({
    "index.html": "10982c08ba967d4ad232a51756a20c1153e7c150e9e91b3b1588f6eacf2c6ff0",
    "js/core/fastMediaEngine.js": "ca439659f0a7b0627ca9e05ab223c595be33a25f6dc56b876733af093d819d79",
    "js/core/state.js": "01f78a5baae76cab0e9d24385e3364d3d0d122ba3d0e6895532f332def429661",
    "js/main.js": "4ae28b70cb7538eb8e11653757c8ea19a0978f309ca8804abdfc9ac2ec9dcf24",
    "js/textanim/textanim.js": "b7fa799ad305d9fbdd19c03e1dfa5ce651785de41f0b6196e16ad8162b710d2f",
    "js/toolkit/effects.js": "ef9e2c81a2d0e7a6472c604e9b642e2834bfd510fefcdc306421fe5084a56383",
    "js/toolkit/flow.js": "39587831f0a35b56632d6899e07f34015b7f95ba6d900948e3d129f0c8ff7381",
    "js/toolkit/toolkit.js": "6e7cb2ad29806927f71ddb5f82d88035306357c8b66c3bb33f6a0122cf656fc3",
    "js/ui/accent.js": "3db52e187e633c42d220443c194b9c86b90851ea91098c59e7161f5db6117f87",
    "js/core/featureFlags.js": "747236484eac5b925085d50545caca753e2f7933e705e325ad922d32e7c1b729",
    "js/core/observability.js": "c6e7708a5a322264609c3f6ddb33fc871f1d154bb1f1460e8255a22d9d50f3d3",
    "js/core/appLifecycle.js": "a01e054bf1ea133684e375d620d27e33ef9ef6ed03804cbeef767a08f9d42083",
    "js/core/scheduler.js": "34b775c3d8860ab8d4e3b6d668c968c2c5d970696da7abcd6dd68384d2af447f",
});

function sha256File(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function hashTree(dir) {
    const out = {};
    function visit(current) {
        fs.readdirSync(current, { withFileTypes: true })
            .sort(function (a, b) { return a.name.localeCompare(b.name); })
            .forEach(function (entry) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) visit(full);
                else if (entry.isFile()) out[path.relative(dir, full).replace(/\\/g, "/")] = sha256File(full);
            });
    }
    visit(dir);
    return out;
}

function assertIsolatedRuntimePath(candidate) {
    const normalized = path.resolve(candidate).replace(/\\/g, "/").toLowerCase();
    const temp = path.resolve(os.tmpdir()).replace(/\\/g, "/").toLowerCase();
    const project = ROOT.replace(/\\/g, "/").toLowerCase();
    expect(normalized === temp || normalized.indexOf(temp + "/") === 0).toBe(true);
    expect(normalized === project || normalized.indexOf(project + "/") === 0).toBe(false);
    expect(normalized.indexOf("compsaver_librarypaths") === -1).toBe(true);
    expect(normalized.indexOf(".compsaver_metadata.json") === -1).toBe(true);
    expect(normalized.indexOf(MNTOOLS_ROOT.toLowerCase()) === -1).toBe(true);
}

function withCopiedFixture(run) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "compsaver-phase0-preservation-"));
    assertIsolatedRuntimePath(sandbox);
    const seed = path.join(sandbox, "seed-read-only");
    const copiedLibrary = path.join(sandbox, "copied-library");
    const copiedProject = path.join(sandbox, "copied-project", "project.aep");
    try {
        fs.mkdirSync(path.join(seed, "comp", "Titles", "Golden"), { recursive: true });
        fs.writeFileSync(path.join(seed, "comp", "Titles", "Golden", "meta.json"), JSON.stringify({
            id: "golden", name: "Golden", category: "Titles", section: "comp"
        }), "utf8");
        fs.writeFileSync(path.join(seed, "comp", "Titles", "Golden", "thumbnail.png"), "copied-thumbnail", "utf8");
        fs.mkdirSync(path.dirname(copiedProject), { recursive: true });
        fs.writeFileSync(copiedProject, "ISOLATED_AE_PROJECT_FIXTURE", "utf8");
        fs.cpSync(seed, copiedLibrary, { recursive: true });
        const before = {
            seed: hashTree(seed),
            copiedLibrary: hashTree(copiedLibrary),
            project: sha256File(copiedProject),
        };
        run({ sandbox, seed, copiedLibrary, copiedProject, before });
        expect(hashTree(seed)).toEqual(before.seed);
        expect(hashTree(copiedLibrary)).toEqual(before.copiedLibrary);
        expect(sha256File(copiedProject)).toBe(before.project);
    } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
}

function observeReduceFirstSave(label, folderPath, failure) {
    const log = [];
    const disk = { "/isolated/live.aep": "LIVE_PROJECT_BYTES" };
    const memory = { value: "LIVE_PROJECT_BYTES" };
    const originalFile = { path: "/isolated/live.aep" };
    const targetFile = { path: folderPath + "/project.aep" };
    let undoDepth = 0;
    let suppressDepth = 0;
    const app = {
        beginUndoGroup: function () { undoDepth++; log.push("undo.begin"); },
        endUndoGroup: function () { undoDepth--; log.push("undo.end"); },
        beginSuppressDialogs: function () { suppressDepth++; log.push("dialogs.begin"); },
        endSuppressDialogs: function () { suppressDepth--; log.push("dialogs.end"); },
        open: function (file) { log.push("project.reopen"); memory.value = disk[file.path]; },
        project: {
            save: function (file) {
                const kind = file === originalFile ? "protective" : "template";
                log.push("save." + kind);
                if (failure === "template" && kind === "template") throw new Error("template failure");
                disk[file.path] = memory.value;
            },
            reduceProject: function () {
                log.push("reduce");
                memory.value = "REDUCED_TEMPLATE_BYTES";
                if (failure === "reduce") throw new Error("reduce failure");
            },
        },
    };
    const result = runReduceFirstSave(app, {
        undoLabel: label,
        originalFile,
        targetFile,
        folderPath,
        buildTempComp: function () { log.push("temp.build"); return { remove: function () { log.push("temp.remove"); } }; },
        collectFootageAssets: function () { log.push("assets.collect"); return ["asset-a"]; },
        needsThumbnail: true,
        needsPreview: true,
        enqueueBackgroundJob: function (job) { log.push("enqueue." + job.kind); },
    });
    return {
        ok: result.ok,
        log,
        liveDisk: disk[originalFile.path],
        liveMemory: memory.value,
        templateDisk: disk[targetFile.path] || null,
        undoDepth,
        suppressDepth,
        reopened: result.reopened,
        renderKinds: (result.renderJobs || []).map(function (job) { return job.kind; }),
    };
}

function observeImport(templates, cachedIds) {
    const calls = [];
    let result = null;
    importTemplates({
        encode: legacyBridge.encodeBridge,
        decode: legacyBridge.decodeBridge,
        resolveCached: function (template) {
            return cachedIds.indexOf(String(template.id)) >= 0 ? { status: "cached", reason: "golden-cache" } : null;
        },
        callHost: function (payloadHex, done) {
            const payload = JSON.parse(legacyBridge.decodeBridge(payloadHex));
            calls.push(payload);
            done(legacyBridge.encodeBridge(JSON.stringify({
                perTemplate: payload.templates.map(function (template) {
                    return { id: String(template.id), status: "imported" };
                }),
            })));
        },
    }, { rootPath: "C:/copied-library", templates }, function (value) { result = value; });
    return { calls, result };
}

function makeTemplateContext(templates, section, category, search) {
    const context = {
        console,
        setTimeout,
        clearTimeout,
        window: {},
        document: { getElementById: function () { return null; } },
        DOM: { "search-box": { value: search } },
        allTemplates: templates,
        currentSection: section,
        currentCategory: category,
        tmpBulkSelected: ["preserved-selection"],
        SECTIONS: { COMP: "comp", LAYER: "layer", FOOTAGE: "footage", EFFECT: "effect", ICON: "icon" },
        getTemplateSection: function (template) { return template.section; },
        isTextSection: function () { return false; },
        isImageSection: function () { return false; },
        escapeAttr: function (value) { return String(value == null ? "" : value); },
        escapeHTML: function (value) { return String(value == null ? "" : value); },
        forceIconGrid: function () { },
        TextAnim: { attachHoverPreviews: function () { } },
        Date,
        encodeURI,
    };
    vm.createContext(context);
    vm.runInContext(SOURCE.templates, context, { filename: "templates.js" });
    context.renderCards = function (items) { context.observed = items.slice(); };
    context.renderIcons = context.renderCards;
    return context;
}

function expectedLegacyFilter(templates, section, category, search) {
    const query = search.toLowerCase().trim();
    return templates.filter(function (template) {
        if (template.section !== section) return false;
        if (category === "Favorites" && !template.favorite) return false;
        if (category !== "All" && category !== "Favorites" && template.category !== category) return false;
        if (!query) return true;
        const haystack = ((template.name || "") + " " + (template.category || "") + " " +
            (template.type || "") + " " + (template.section || "") + " " +
            (template.dim || "")).toLowerCase();
        return haystack.indexOf(query) !== -1;
    });
}

function observeImportBatchUndoEnvelope(failingId) {
    const events = [];
    const layers = [];
    const items = [];
    let undoDepth = 0;
    let nextItemId = 100;

    function removable(collection, kind, id) {
        return {
            id: id,
            remove: function () {
                events.push(kind + ".remove:" + id);
                const index = collection.indexOf(this);
                if (index >= 0) collection.splice(index, 1);
            },
        };
    }

    function CompItem() { }
    const comp = new CompItem();
    layers.push(removable(layers, "layer", "initial-layer"));
    Object.defineProperty(comp, "numLayers", { get: function () { return layers.length; } });
    comp.layer = function (index) { return layers[index - 1]; };

    items.push(removable(items, "item", nextItemId++));
    const project = {
        activeItem: comp,
        item: function (index) { return items[index - 1]; },
    };
    Object.defineProperty(project, "numItems", { get: function () { return items.length; } });

    const context = {
        console,
        CompItem,
        FolderItem: function FolderItem() { },
        FootageItem: function FootageItem() { },
        app: {
            project,
            beginUndoGroup: function () { undoDepth++; events.push("undo.begin"); },
            endUndoGroup: function () {
                events.push("cleanup.io:" + String(context.__CS_IMPORT_IO === null));
                events.push("cleanup.guard:" + String(context.__CS_IMPORT_BATCH_ACTIVE === false));
                undoDepth--;
                events.push("undo.end");
            },
        },
        $: { hiresTimer: 1 },
        encodeBridge: function (value) { return value; },
        decodeBridge: function (value) { return value; },
        jsonStringify: JSON.stringify,
    };
    vm.createContext(context);
    vm.runInContext(IMPORT_SOURCE, context, { filename: "import.jsx" });

    const snapshotLayers = context.csSnapshotCompLayers;
    const snapshotItems = context.csSnapshotProjectItemIds;
    const rollback = context.csRollbackToSnapshot;
    context.csSnapshotCompLayers = function (activeComp) {
        events.push("snapshot.layers");
        return snapshotLayers(activeComp);
    };
    context.csSnapshotProjectItemIds = function () {
        events.push("snapshot.items");
        return snapshotItems();
    };
    context.csRollbackToSnapshot = function (activeComp, layerRefsBefore, itemIdsBefore) {
        events.push("rollback");
        return rollback(activeComp, layerRefsBefore, itemIdsBefore);
    };
    context.importCompDirect = function (id) {
        events.push("dispatch:" + id);
        context.csBeginUndoGroup("inner label is irrelevant");
        layers.push(removable(layers, "layer", id));
        items.push(removable(items, "item", nextItemId++));
        context.csEndUndoGroup();
        return id === failingId ? "injected failure" : "true";
    };

    const payload = {
        rootPath: "C:/copied-library",
        templates: [
            { id: "a", section: "comp", category: "Titles" },
            { id: "b", section: "comp", category: "Titles" },
        ],
    };
    const result = JSON.parse(context.importBatch(JSON.stringify(payload)));
    return {
        events,
        result,
        undoDepth,
        batchActive: context.__CS_IMPORT_BATCH_ACTIVE,
        ioActive: context.__CS_IMPORT_IO,
        layerIds: layers.map(function (layer) { return layer.id; }),
        itemCount: items.length,
    };
}

const preservationTemplateArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 12 }),
    name: fc.string({ maxLength: 18 }),
    category: fc.constantFrom("Titles", "Transitions", "Unicode Ω"),
    section: fc.constantFrom("comp", "layer"),
    type: fc.constantFrom("comp", "media"),
    dim: fc.constantFrom("1920x1080", "3840x2160", ""),
    favorite: fc.boolean(),
}).map(function (template) {
    return Object.assign(template, {
        folderPath: "C:/copied-library/" + template.section + "/" + template.category + "/" + template.id,
        sourcePath: "C:/copied-library",
    });
});

const preservationScenarioArb = fc.record({
    approved: fc.constant(false),
    phase: fc.integer({ min: 1, max: 4 }),
    operation: fc.constantFrom.apply(fc, MANIFESTATIONS),
    payloadBytes: fc.integer({ min: 0, max: 2000000 }),
    negotiatedInlineLimit: fc.constant(49152),
    transport: fc.constantFrom("legacy-hex", "none"),
    mediaLaneBounded: fc.boolean(),
    mediaCommitAtomic: fc.boolean(),
    mediaHasTerminalOwner: fc.boolean(),
    templates: fc.uniqueArray(preservationTemplateArb, { minLength: 1, maxLength: 20, selector: function (t) { return t.folderPath; } }),
    section: fc.constantFrom("comp", "layer"),
    category: fc.constantFrom("All", "Favorites", "Titles", "Transitions", "Unicode Ω"),
    search: fc.constantFrom("", "title", "MEDIA", "1920", " Ω ", "no-match"),
});

describe("Phase 0 Property 2: non-bug behavior remains observably equivalent", function () {
    test("generated non-bug scenarios preserve exact search/category order, UI state, roots, schemas, and bridge values", function () {
        fc.assert(fc.property(preservationScenarioArb, function (input) {
            expect(isBugCondition(input)).toBe(false);

            const templateContext = makeTemplateContext(input.templates, input.section, input.category, input.search);
            const beforeUi = {
                category: templateContext.currentCategory,
                selection: templateContext.tmpBulkSelected.slice(),
                focus: "search-box",
                scrollTop: 137,
            };
            const categories = Array.from(templateContext.getSectionCategories(templateContext.getSectionTemplates()));
            templateContext.filterAndRender();
            const expected = expectedLegacyFilter(input.templates, input.section, input.category, input.search);
            expect(Array.from(templateContext.observed).map(function (t) { return t.id; }))
                .toEqual(expected.map(function (t) { return t.id; }));
            expect(categories).toEqual(["All", "Favorites"].concat(
                input.templates.filter(function (t) { return t.section === input.section; })
                    .map(function (t) { return t.category; })
                    .filter(function (value, index, all) { return value && all.indexOf(value) === index; })
            ));
            expect({
                category: templateContext.currentCategory,
                selection: Array.from(templateContext.tmpBulkSelected),
                focus: "search-box",
                scrollTop: 137,
            }).toEqual(beforeUi);

            const index = new LibraryIndex({ validityKey: "phase-0-key" });
            input.templates.forEach(function (template) { expect(index.insertAtHead(template)).toBe(true); });
            const beforeCrud = index.entries();
            const target = beforeCrud[Math.floor(beforeCrud.length / 2)];
            expect(index.patchEntry(target.folderPath, { name: target.name + " patched" })).toBe(true);
            expect(index.getEntry(target.folderPath).sourcePath).toBe(target.sourcePath);
            expect(index.entries().filter(function (entry) { return entry.folderPath !== target.folderPath; }))
                .toEqual(beforeCrud.filter(function (entry) { return entry.folderPath !== target.folderPath; }));
            expect(index.removeEntry(target.folderPath)).toBe(true);
            expect(index.has(target.folderPath)).toBe(false);

            const indexEnvelope = JSON.parse(index.serialize());
            expect(Object.keys(indexEnvelope)).toEqual(["version", "validityKey", "entries"]);
            expect(indexEnvelope.version).toBe(LIBRARY_INDEX_VERSION);
            expect(LibraryIndex.parse(index.serialize()).entries()).toEqual(index.entries());

            const unicode = JSON.stringify({ ids: input.templates.map(function (t) { return t.id; }), query: input.search, value: "Ω😀\u0000" });
            expect(legacyBridge.decodeBridge(legacyBridge.encodeBridge(unicode))).toBe(unicode);
        }), { seed: 70707, numRuns: 100 });
    });

    test("freezes reduce-first save, exact failure cleanup, zero/one-call import, and one host undo/rollback envelope", function () {
        const success = observeReduceFirstSave("Golden Save", "/isolated/template", "none");
        expect(success).toEqual({
            ok: true,
            log: ["undo.begin", "save.protective", "temp.build", "reduce", "save.template", "assets.collect", "undo.end", "dialogs.begin", "project.reopen", "dialogs.end", "enqueue.thumbnail", "enqueue.preview"],
            liveDisk: "LIVE_PROJECT_BYTES",
            liveMemory: "LIVE_PROJECT_BYTES",
            templateDisk: "REDUCED_TEMPLATE_BYTES",
            undoDepth: 0,
            suppressDepth: 0,
            reopened: 1,
            renderKinds: ["thumbnail", "preview"],
        });
        ["reduce", "template"].forEach(function (failure) {
            const observed = observeReduceFirstSave("Golden Save", "/isolated/template", failure);
            expect(observed.ok).toBe(false);
            expect(observed.liveDisk).toBe("LIVE_PROJECT_BYTES");
            expect(observed.liveMemory).toBe("LIVE_PROJECT_BYTES");
            expect(observed.undoDepth).toBe(0);
            expect(observed.suppressDepth).toBe(0);
            expect(observed.reopened).toBe(1);
            expect(observed.renderKinds).toEqual([]);
        });

        const templates = [
            { id: "a", name: "A", folderPath: "C:/copied/a", sourcePath: "C:/copied" },
            { id: "b", name: "B", folderPath: "D:/copied/b", sourcePath: "D:/copied" },
        ];
        const cached = observeImport(templates, ["a", "b"]);
        expect(cached.calls).toEqual([]);
        expect(cached.result).toEqual({
            perTemplate: [
                { id: "a", status: "cached", reason: "golden-cache" },
                { id: "b", status: "cached", reason: "golden-cache" },
            ],
            bridgeCalls: 0,
        });
        const uncached = observeImport(templates, []);
        expect(uncached.calls).toHaveLength(1);
        expect(uncached.calls[0].templates.map(function (t) { return t.id; })).toEqual(["a", "b"]);
        expect(uncached.result.bridgeCalls).toBe(1);
        expect(uncached.result.perTemplate.map(function (t) { return t.status; })).toEqual(["imported", "imported"]);

        function expectSingleOuterUndoEnvelope(observed) {
            expect(observed.events.filter(function (event) { return event === "undo.begin"; })).toHaveLength(1);
            expect(observed.events.filter(function (event) { return event === "undo.end"; })).toHaveLength(1);
            expect(observed.events[0]).toBe("undo.begin");
            expect(observed.events.slice(-3)).toEqual(["cleanup.io:true", "cleanup.guard:true", "undo.end"]);
            expect(observed.events.filter(function (event) { return event === "snapshot.layers"; })).toHaveLength(2);
            expect(observed.events.filter(function (event) { return event === "snapshot.items"; })).toHaveLength(2);
            expect(observed.events.filter(function (event) { return event.indexOf("dispatch:") === 0; }))
                .toEqual(["dispatch:a", "dispatch:b"]);
            expect(observed.undoDepth).toBe(0);
            expect(observed.batchActive).toBe(false);
            expect(observed.ioActive).toBe(null);
        }

        const successfulBatch = observeImportBatchUndoEnvelope(null);
        expectSingleOuterUndoEnvelope(successfulBatch);
        expect(successfulBatch.events.filter(function (event) { return event === "rollback"; })).toEqual([]);
        expect(successfulBatch.result.perTemplate).toEqual([
            { id: "a", status: "imported" },
            { id: "b", status: "imported" },
        ]);
        expect(successfulBatch.layerIds).toEqual(["initial-layer", "a", "b"]);
        expect(successfulBatch.itemCount).toBe(3);

        const failedBatch = observeImportBatchUndoEnvelope("b");
        expectSingleOuterUndoEnvelope(failedBatch);
        expect(failedBatch.events.filter(function (event) { return event === "rollback"; })).toHaveLength(1);
        expect(failedBatch.events.indexOf("rollback")).toBeGreaterThan(failedBatch.events.indexOf("dispatch:b"));
        expect(failedBatch.events.indexOf("rollback")).toBeLessThan(failedBatch.events.indexOf("cleanup.io:true"));
        expect(failedBatch.result.perTemplate).toEqual([
            { id: "a", status: "imported" },
            { id: "b", status: "failed", reason: "injected failure" },
        ]);
        expect(failedBatch.layerIds).toEqual(["initial-layer", "a"]);
        expect(failedBatch.itemCount).toBe(2);
    });

    test("freezes current cache/index disk schemas, corruption fallback, and legacy bridge exports", async function () {
        const cache = new MetadataCache();
        cache.put("C:\\copied\\template\\", { name: "Golden", fields: [1, 2] }, "vk-1");
        expect(JSON.parse(cache.serialize())).toEqual({
            version: METADATA_CACHE_VERSION,
            entries: [{ folderPath: "C:/copied/template", validityKey: "vk-1", metadata: { name: "Golden", fields: [1, 2] } }],
        });
        [null, "", "not-json", "{}", "[]", JSON.stringify({ entries: "bad" })].forEach(function (corrupt) {
            const parsedCache = MetadataCache.parse(corrupt);
            expect(parsedCache.entries()).toEqual([]);
            const parsedIndex = LibraryIndex.parse(corrupt);
            expect(parsedIndex.entries()).toEqual([]);
            expect(parsedIndex.needsFullScan()).toBe(true);
        });
        expect(Object.keys(legacyBridge).sort()).toEqual(["callHost", "decodeBridge", "encodeBridge"]);
        const bridgeResult = await legacyBridge.callHost("legacyCall()", {
            timeoutMs: 100,
            csInterface: { evalScript: function (_, done) { done(legacyBridge.encodeBridge("legacy-result")); } },
        });
        expect(bridgeResult).toEqual({ ok: true, result: "legacy-result" });
    });

    test("uses only copied temporary fixtures and preserves production, evidence, dependency, user-data, and MNTOOLS hashes", function () {
        const evidenceBefore = hashTree(IMMUTABLE_EVIDENCE);
        const dependencyPaths = ["package.json", "package-lock.json"].filter(function (rel) { return fs.existsSync(path.join(ROOT, rel)); });
        const dependencyBefore = dependencyPaths.reduce(function (out, rel) {
            out[rel] = sha256File(path.join(ROOT, rel));
            return out;
        }, {});

        const approvedChangedPaths = [];
        SOURCE_BASELINE.compSaverProductionFiles.forEach(function (entry) {
            const expected = Object.prototype.hasOwnProperty.call(PHASE_1_AUTHORIZED_HASHES, entry.path)
                ? PHASE_1_AUTHORIZED_HASHES[entry.path]
                : entry.sha256;
            expect(sha256File(path.join(ROOT, entry.path))).toBe(expected);
            if (expected !== entry.sha256) approvedChangedPaths.push(entry.path);
        });
        expect(approvedChangedPaths).toEqual([
            "index.html",
            "js/core/fastMediaEngine.js",
            "js/core/state.js",
            "js/main.js",
            "js/textanim/textanim.js",
            "js/toolkit/effects.js",
            "js/toolkit/flow.js",
            "js/toolkit/toolkit.js",
            "js/ui/accent.js",
        ]);
        Object.keys(PHASE_1_AUTHORIZED_HASHES).filter(function (entryPath) {
            return !SOURCE_BASELINE.compSaverProductionFiles.some(function (entry) {
                return entry.path === entryPath;
            });
        }).forEach(function (entryPath) {
            expect(sha256File(path.join(ROOT, entryPath))).toBe(PHASE_1_AUTHORIZED_HASHES[entryPath]);
        });
        SOURCE_BASELINE.mnTools.relevantFiles.forEach(function (entry) {
            expect(sha256File(path.join(MNTOOLS_ROOT, entry.path))).toBe(entry.sha256);
        });

        withCopiedFixture(function (fixture) {
            assertIsolatedRuntimePath(fixture.copiedLibrary);
            assertIsolatedRuntimePath(fixture.copiedProject);
            expect(fixture.before.copiedLibrary).toEqual(fixture.before.seed);
            expect(fs.readFileSync(fixture.copiedProject, "utf8")).toBe("ISOLATED_AE_PROJECT_FIXTURE");
        });

        expect(hashTree(IMMUTABLE_EVIDENCE)).toEqual(evidenceBefore);
        dependencyPaths.forEach(function (rel) {
            expect(sha256File(path.join(ROOT, rel))).toBe(dependencyBefore[rel]);
        });
    });
});
