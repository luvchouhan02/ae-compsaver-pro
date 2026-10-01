/**
 * Property 16 — Media index migration and persistence round-trip without loss.
 *
 * Feature: media-engine-lag — Task 4.2
 * Validates: Requirements 5.4, 5.5, 5.11
 *
 * What is under test
 * ------------------
 * The real media repository operations added to js/core/persistence.js
 * (`MediaEntryRepository.commitOptimisticBatch`, `snapshot`, and the durable
 * warm-render publish path) together with `normalizeMediaEntry`.
 *
 * The round trip exercised here is the full production path:
 *   import-session entries
 *     -> commitOptimisticBatch (clone + normalize + serialize + persist)
 *     -> session warm-render projection (the mirrored render array)
 *     -> JSON.parse of the persisted payload (panel restart)
 *     -> warm load into a fresh repository + commit
 *     -> warm-render projection
 *
 * Every generated entry mixes:
 *   - new-style records with top-level media fields,
 *   - legacy records whose media fields live inside a nested `metadata` object,
 *   - hybrid records where the same field name exists at both levels, and
 *   - arbitrary unrecognized JSON-compatible field names/values at both levels.
 *
 * Pure logic only — no filesystem, no browser, no After Effects.
 */

"use strict";

const fc = require("fast-check");
const { MediaEntryRepository } = require("../js/core/persistence.js");

// ─── Reference model (independent of the implementation) ──────────────────────

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function jsonClone(value) {
    return JSON.parse(JSON.stringify(value));
}

// The only permitted value change during the round trip.
function normalizePath(value) {
    return ("" + (value || "")).replace(/\\/g, "/").replace(/\/+$/, "");
}

function isSourcePathField(key) {
    return /^(source(Path|File)?|original(Path|File)?|mediaSource(Path)?)$/i.test(key);
}

function isNormalizedPathField(key) {
    return key === "folderPath" || isSourcePathField(key);
}

function normalizePathFields(record) {
    Object.keys(record).forEach(function (key) {
        if (isNormalizedPathField(key) && typeof record[key] === "string") {
            record[key] = normalizePath(record[key]);
        }
    });
    return record;
}

// Reference migration: promote every present nested media field that has no
// top-level counterpart, keep the legacy object, normalize path fields, and
// deterministically derive a missing legacy ID.
function referenceNormalize(entry) {
    const out = jsonClone(entry);
    if (isPlainObject(out.metadata)) {
        normalizePathFields(out.metadata);
        Object.keys(out.metadata).forEach(function (key) {
            if (!hasOwn(out, key)) out[key] = jsonClone(out.metadata[key]);
        });
    }
    normalizePathFields(out);
    if (out.id === undefined || out.id === null || out.id === "") {
        const legacyPath =
            (typeof out.sourcePath === "string" ? normalizePath(out.sourcePath) : "") ||
            (typeof out.folderPath === "string" ? normalizePath(out.folderPath) : "");
        out.id = "legacy-" + encodeURIComponent(legacyPath);
    }
    return out;
}

// ─── Generators ──────────────────────────────────────────────────────────────

// Unrecognized field names: never a reserved key and never a source-path field.
const unknownKeyArb = fc.stringMatching(/^x[A-Za-z0-9_]{1,6}$/);

// Recognized media field names that may appear at the top level, inside the
// legacy metadata object, or in both places (conflict case).
const mediaFieldArb = fc.constantFrom(
    "displayName",
    "category",
    "durationSeconds",
    "thumbFile",
    "proxyFile",
    "codec",
    "thumbStatus"
);

// Arbitrary JSON-compatible values (scalars, arrays, records).
const leafArb = fc.oneof(
    fc.string({ maxLength: 8 }),
    fc.integer({ min: -5000, max: 5000 }),
    fc.boolean(),
    fc.constant(null)
);
const jsonValueArb = fc.oneof(
    leafArb,
    fc.array(leafArb, { maxLength: 3 }),
    fc.dictionary(unknownKeyArb, leafArb, { maxKeys: 3 })
);

const entryPlanArb = fc.record({
    style: fc.constantFrom("new", "legacy", "hybrid"),
    pathStyle: fc.constantFrom("posix", "windows", "trailing", "windows-trailing"),
    hasId: fc.boolean(),
    hasFolderPath: fc.boolean(),
    hasLegacyFolderPath: fc.boolean(),
    topMedia: fc.dictionary(mediaFieldArb, jsonValueArb, { maxKeys: 4 }),
    legacyMedia: fc.dictionary(mediaFieldArb, jsonValueArb, { maxKeys: 4 }),
    topUnknown: fc.dictionary(unknownKeyArb, jsonValueArb, { maxKeys: 3 }),
    legacyUnknown: fc.dictionary(unknownKeyArb, jsonValueArb, { maxKeys: 3 }),
});

// Distinct base paths per position keep normalized source paths unique so the
// repository's source-path de-duplication cannot hide a lost entry.
function decoratePath(posixPath, pathStyle) {
    if (pathStyle === "windows") return posixPath.replace(/\//g, "\\");
    if (pathStyle === "trailing") return posixPath + "//";
    if (pathStyle === "windows-trailing") return posixPath.replace(/\//g, "\\") + "\\\\";
    return posixPath;
}

function buildEntry(plan, position) {
    const posixSource = "C:/media/lib" + position + "/clip" + position + ".mov";
    const decoratedSource = decoratePath(posixSource, plan.pathStyle);
    const entry = {};

    // Unrecognized then recognized top-level fields.
    Object.keys(plan.topUnknown).forEach(function (key) {
        entry[key] = plan.topUnknown[key];
    });
    Object.keys(plan.topMedia).forEach(function (key) {
        entry[key] = plan.topMedia[key];
    });

    if (plan.hasId) entry.id = "media-" + position;
    if (plan.hasFolderPath) {
        entry.folderPath = decoratePath("C:/media/lib" + position, plan.pathStyle);
    }

    // New-style records carry the source path at the top level. Legacy records
    // carry it only inside metadata. Hybrid records carry both, with a
    // deliberately conflicting nested value.
    if (plan.style === "new" || plan.style === "hybrid") {
        entry.sourcePath = decoratedSource;
    }

    if (plan.style === "legacy" || plan.style === "hybrid") {
        const metadata = {};
        Object.keys(plan.legacyUnknown).forEach(function (key) {
            metadata[key] = plan.legacyUnknown[key];
        });
        Object.keys(plan.legacyMedia).forEach(function (key) {
            // Ensure conflicting values differ from the top-level value so a
            // silent nested overwrite is detectable.
            metadata[key] = { legacyOf: key, value: plan.legacyMedia[key] };
        });
        metadata.sourcePath = plan.style === "hybrid"
            ? decoratePath("D:/legacy/old" + position + ".mov", plan.pathStyle)
            : decoratedSource;
        if (plan.hasLegacyFolderPath) {
            metadata.folderPath = decoratePath("D:/legacy/lib" + position, plan.pathStyle);
        }
        entry.metadata = metadata;
    }

    return entry;
}

function makeRepository(entries, mirror, validityKey) {
    const persisted = [];
    const repository = new MediaEntryRepository({
        storageKey: "compSaver_mediaIndex_test",
        entries: entries,
        allTemplates: mirror,
        validityKey: validityKey,
        persist: function (serialized) {
            persisted.push(serialized);
        },
    });
    return { repository: repository, persisted: persisted };
}

// ─── Property 16 ─────────────────────────────────────────────────────────────
// Feature: media-engine-lag, Property 16: Media index migration and persistence round-trip without loss
// **Validates: Requirements 5.4, 5.5, 5.11**
describe("Property 16: Media index migration and persistence round-trip without loss (Req 5.4, 5.5, 5.11)", () => {
    test("normalization promotes every present media field and no field name or value is lost through persistence and warm-render projection", () => {
        fc.assert(
            fc.property(
                fc.array(entryPlanArb, { minLength: 1, maxLength: 6 }),
                fc.oneof(fc.string({ maxLength: 6 }), fc.constant(null)),
                (plans, validityKey) => {
                    const entries = plans.map(buildEntry);
                    const frozen = jsonClone(entries); // the caller's original values

                    // ── Import session: one durable commit ───────────────────
                    const sessionMirror = [];
                    const session = makeRepository([], sessionMirror, validityKey);
                    const commit = session.repository.commitOptimisticBatch(entries);
                    expect(commit.ok).toBe(true);
                    expect(session.persisted.length).toBe(1);

                    // ── Panel restart: parse the persisted payload ────────────
                    const envelope = JSON.parse(session.persisted[0]);
                    expect(Array.isArray(envelope.entries)).toBe(true);

                    // ── Warm startup: load, migrate, and project for render ───
                    const warmMirror = [];
                    const warm = makeRepository(envelope.entries, warmMirror, envelope.validityKey);
                    const warmCommit = warm.repository.commitOptimisticBatch([]);
                    expect(warmCommit.ok).toBe(true);

                    // Ordering and cardinality survive the round trip.
                    expect(sessionMirror.length).toBe(entries.length);
                    expect(warmMirror.length).toBe(entries.length);
                    expect(warm.repository.snapshot()).toEqual(session.repository.snapshot());

                    for (let i = 0; i < entries.length; i++) {
                        const original = frozen[i];
                        const expected = referenceNormalize(original);
                        const rendered = warmMirror[i];

                        // The projection is the normalized entry, exactly, and the
                        // warm projection equals the import-session projection.
                        expect(rendered).toEqual(expected);
                        expect(rendered).toEqual(sessionMirror[i]);

                        // (5.4 / 5.11) Every field the caller supplied at the top
                        // level survives with its value, except normalized paths.
                        Object.keys(original).forEach(function (key) {
                            expect(hasOwn(rendered, key)).toBe(true);
                            if (key === "metadata") return;
                            if (isNormalizedPathField(key) && typeof original[key] === "string") {
                                expect(rendered[key]).toBe(normalizePath(original[key]));
                            } else {
                                expect(rendered[key]).toEqual(original[key]);
                            }
                        });

                        if (isPlainObject(original.metadata)) {
                            // (5.4) Every present nested media field is promoted to
                            // the top level, and the legacy object is retained.
                            expect(isPlainObject(rendered.metadata)).toBe(true);
                            Object.keys(original.metadata).forEach(function (key) {
                                expect(hasOwn(rendered, key)).toBe(true);

                                const nested = isNormalizedPathField(key) &&
                                    typeof original.metadata[key] === "string"
                                    ? normalizePath(original.metadata[key])
                                    : original.metadata[key];

                                // The retained legacy object keeps its own values
                                // (paths normalized).
                                expect(rendered.metadata[key]).toEqual(nested);

                                if (hasOwn(original, key)) {
                                    // A top-level value is NEVER replaced by a
                                    // conflicting nested value.
                                    const top = isNormalizedPathField(key) &&
                                        typeof original[key] === "string"
                                        ? normalizePath(original[key])
                                        : original[key];
                                    expect(rendered[key]).toEqual(top);
                                } else {
                                    expect(rendered[key]).toEqual(nested);
                                }
                            });
                        } else {
                            expect(hasOwn(rendered, "metadata")).toBe(false);
                        }

                        // (5.5) A stable identity is always available for render,
                        // and normalized source paths carry no residual separators.
                        expect(typeof rendered.id === "string" && rendered.id.length > 0).toBe(true);
                        expect(rendered.sourcePath.indexOf("\\")).toBe(-1);
                        expect(/\/$/.test(rendered.sourcePath)).toBe(false);
                    }
                }
            ),
            { numRuns: 120 }
        );
    });
});

/**
 * Property 19 — Failed repository operations preserve the last commit.
 *
 * Feature: media-engine-lag — Task 4.3
 * Validates: Requirements 5.13
 *
 * What is under test
 * ------------------
 * The real `MediaEntryRepository` transaction discipline from
 * js/core/persistence.js. Each run performs one successful durable commit,
 * then arms exactly one injected failure point on the commit pipeline:
 *
 *   normalization  -> the per-entry normalizer throws / returns a non-entry
 *   serialization  -> the serializer throws / returns a non-string
 *   storage        -> the persist sink throws / returns a rejected Promise
 *
 * and re-attempts one repository operation (`commitOptimisticBatch`,
 * `patchById`, or `refreshValidityAsync`). The failed attempt must leave the
 * last successfully persisted and published index completely unchanged —
 * entries, order, values, validity key, the last durable serialization, and
 * the warm-render mirror array (same array instance, same contents) — and must
 * hand the caller a typed error result naming the failed operation.
 *
 * Pure logic only — no filesystem, no browser, no After Effects.
 */

// ─── Generators / builders for Property 19 ───────────────────────────────────

const p19EntryPlanArb = fc.record({
    hasId: fc.boolean(),
    windowsPath: fc.boolean(),
    hasLegacyMetadata: fc.boolean(),
    category: fc.constantFrom("video", "image", "audio"),
    unknown: fc.oneof(fc.string({ maxLength: 6 }), fc.integer({ min: 0, max: 99 }), fc.constant(null)),
});

function buildP19Entry(plan, position) {
    const posix = "C:/media/p19/clip" + position + ".mov";
    const entry = {
        sourcePath: plan.windowsPath ? posix.replace(/\//g, "\\") : posix,
        displayName: "clip" + position,
        category: plan.category,
        xUnknown: plan.unknown,
    };
    if (plan.hasId) entry.id = "media-p19-" + position;
    if (plan.hasLegacyMetadata) {
        entry.metadata = { codec: plan.category + "-codec", xNested: position };
    }
    return entry;
}

const p19FailurePlanArb = fc.record({
    point: fc.constantFrom("normalization", "serialization", "storage"),
    mode: fc.constantFrom("throw", "alternate"),
    operation: fc.constantFrom("commitOptimisticBatch", "patchById", "refreshValidityAsync"),
    targetIndex: fc.nat({ max: 20 }),
});

// One repository whose normalization, serialization, and storage stages can be
// switched to failing after the baseline commit has been published.
function makeInjectableRepository(failurePlan) {
    const state = { armed: false, persistAttempts: [], persistedOk: [] };
    const mirror = [];
    const repository = new MediaEntryRepository({
        storageKey: "compSaver_mediaIndex_p19",
        allTemplates: mirror,
        validityKey: "baseline-key",
        normalizeEntry: function (candidate) {
            if (state.armed && failurePlan.point === "normalization") {
                if (failurePlan.mode === "alternate") return null; // not an entry
                throw new Error("injected normalization failure");
            }
            return candidate;
        },
        serialize: function (envelope) {
            if (state.armed && failurePlan.point === "serialization") {
                if (failurePlan.mode === "alternate") return 42; // not a string
                throw new Error("injected serialization failure");
            }
            return JSON.stringify(envelope);
        },
        persist: function (serialized) {
            state.persistAttempts.push(serialized);
            if (state.armed && failurePlan.point === "storage") {
                if (failurePlan.mode === "alternate") {
                    return Promise.reject(new Error("injected async storage failure"));
                }
                throw new Error("injected storage failure");
            }
            state.persistedOk.push(serialized);
            return undefined;
        },
        deriveValidityKeyAsync: function () {
            return Promise.resolve("refreshed-key");
        },
    });
    return { repository: repository, mirror: mirror, state: state };
}

// ─── Property 19 ─────────────────────────────────────────────────────────────
// Feature: media-engine-lag, Property 19: Failed repository operations preserve the last commit
// **Validates: Requirements 5.13**
describe("Property 19: Failed repository operations preserve the last commit (Req 5.13)", () => {
    test("an injected normalization, serialization, or storage failure returns a typed error naming the operation and leaves the last committed index and warm-render mirror untouched", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(p19EntryPlanArb, { minLength: 1, maxLength: 5 }),
                p19FailurePlanArb,
                async (plans, failurePlan) => {
                    const baselineEntries = plans.map(buildP19Entry);
                    const harness = makeInjectableRepository(failurePlan);
                    const repository = harness.repository;

                    // ── One successful durable commit ────────────────────────
                    const baselineCommit = repository.commitOptimisticBatch(baselineEntries);
                    expect(baselineCommit.ok).toBe(true);
                    expect(harness.state.persistedOk.length).toBe(1);

                    const baselineSnapshot = jsonClone(repository.snapshot());
                    const baselineMirror = jsonClone(harness.mirror);
                    const baselineSerialized = harness.state.persistedOk[0];
                    const baselineEnvelope = JSON.parse(baselineSerialized);
                    const mirrorRef = harness.mirror;
                    const baselineIds = baselineSnapshot.map(function (entry) { return entry.id; });
                    const baselinePaths = baselineSnapshot.map(function (entry) {
                        return entry.sourcePath;
                    });

                    // ── Arm the failure point and re-attempt one operation ───
                    harness.state.armed = true;
                    const target = baselineIds[failurePlan.targetIndex % baselineIds.length];

                    let result;
                    if (failurePlan.operation === "commitOptimisticBatch") {
                        result = repository.commitOptimisticBatch([
                            {
                                id: "media-p19-incoming",
                                sourcePath: "C:/media/p19/incoming.mov",
                                displayName: "incoming",
                                category: "video",
                            },
                        ]);
                    } else if (failurePlan.operation === "patchById") {
                        result = repository.patchById(target, {
                            thumbFile: "thumb-" + failurePlan.targetIndex + ".png",
                            thumbStatus: "ready",
                        });
                    } else {
                        result = repository.refreshValidityAsync();
                    }
                    result = await Promise.resolve(result);

                    // (5.13) The caller receives a typed error result that
                    // identifies the failed operation.
                    expect(!!result).toBe(true);
                    expect(result.ok).toBe(false);
                    expect(result.operation).toBe(failurePlan.operation);
                    expect(result.error instanceof Error).toBe(true);
                    expect(result.snapshot).toBeUndefined();

                    const lastError = repository.lastError();
                    expect(!!lastError).toBe(true);
                    expect(lastError.operation).toBe(failurePlan.operation);
                    expect(typeof lastError.message).toBe("string");

                    // (5.13) The published index is byte-for-byte the previous
                    // commit: same entries, same order, same values.
                    const afterSnapshot = repository.snapshot();
                    expect(afterSnapshot).toEqual(baselineSnapshot);
                    expect(afterSnapshot.map(function (e) { return e.id; })).toEqual(baselineIds);

                    // Keyed and path lookups still resolve the committed data.
                    for (let i = 0; i < baselineIds.length; i++) {
                        expect(repository.getById(baselineIds[i])).toEqual(baselineSnapshot[i]);
                        expect(repository.getBySourcePath(baselinePaths[i])).toEqual(baselineSnapshot[i]);
                    }
                    expect(repository.getById("media-p19-incoming")).toBe(null);

                    // (5.13) The warm-render mirror is the same array instance
                    // holding exactly the previously published projection.
                    expect(harness.mirror).toBe(mirrorRef);
                    expect(harness.mirror).toEqual(baselineMirror);
                    expect(harness.mirror.length).toBe(baselineSnapshot.length);

                    // No new durable serialization was accepted; a storage-stage
                    // failure may attempt a write, the earlier stages may not.
                    expect(harness.state.persistedOk).toEqual([baselineSerialized]);
                    if (failurePlan.point === "storage") {
                        expect(harness.state.persistAttempts.length).toBe(2);
                    } else {
                        expect(harness.state.persistAttempts.length).toBe(1);
                    }

                    // The next healthy commit reproduces the retained index and
                    // validity key, proving nothing partial leaked into state.
                    harness.state.armed = false;
                    const recovery = repository.commitOptimisticBatch([]);
                    expect(recovery.ok).toBe(true);
                    const recoveredEnvelope = JSON.parse(
                        harness.state.persistedOk[harness.state.persistedOk.length - 1]
                    );
                    expect(recoveredEnvelope.entries).toEqual(baselineEnvelope.entries);
                    expect(recoveredEnvelope.validityKey).toBe(baselineEnvelope.validityKey);
                    expect(recoveredEnvelope.validityKey).toBe("baseline-key");
                }
            ),
            { numRuns: 120 }
        );
    });
});
/**
 * Property 17 — Stable identity survives every projection and DOM escaping.
 *
 * Feature: media-engine-lag — Task 5.2
 * Validates: Requirements 5.6, 5.7
 *
 * What is under test
 * ------------------
 * The four projections an imported media item passes through, all real code:
 *
 *   state        — the warm-render mirror the repository publishes, plus the
 *                  per-item stage ledger the import path keys by Stable_Media_ID
 *   persistence  — `MediaEntryRepository` (js/core/persistence.js):
 *                  commitOptimisticBatch / snapshot / getById / getBySourcePath /
 *                  patchById and the serialized payload itself
 *   scheduler    — keyed enqueue records from js/core/scheduler.js
 *                  (`stage|mediaId|normalizedSourcePath`)
 *   DOM          — the shared single-card markup
 *                  (`renderTemplateCardMarkup` + `escapeTemplateCardAttribute`
 *                  in js/templates/templates.js) inserted and patched through the
 *                  real `KeyedMediaCardHelper` (js/core/keyedMediaCardHelper.js)
 *
 * Generated IDs deliberately include double quotes, single quotes, ampersands,
 * angle brackets, entity-looking text (`&amp;`, `&#39;`), percent escapes,
 * Unicode/emoji, and legacy-style `legacy-<encoded path>` values, so the
 * escape -> parse round trip is exercised on exactly the inputs that could
 * corrupt an attribute.
 *
 * Because Jest runs in a "node" environment with no browser DOM and the project
 * pins its dependencies, the markup is parsed by tests/helpers/miniDom.js — a
 * small HTML tokenizer/tree builder with browser attribute-entity decoding
 * (single left-to-right reference pass). No filesystem, no After Effects.
 */

const path = require("path");
const { loadHelpers } = require("./helpers/loadHelpers.js");
const { createMiniDocument, parseSingleElement } = require("./helpers/miniDom.js");
const { KeyedMediaCardHelper } = require("../js/core/keyedMediaCardHelper.js");
const schedulerModule = require("../js/core/scheduler.js");

// ─── Load the real browser-side card markup (no module system) ───────────────
const p17Constants = loadHelpers({ file: path.join("js", "core", "constants.js") });
const p17Utils = loadHelpers({
    file: path.join("js", "core", "utils.js"),
    injected: {
        SECTIONS: p17Constants.get("SECTIONS"),
        IMAGE_SECTIONS: p17Constants.get("IMAGE_SECTIONS"),
    },
});
const p17Templates = loadHelpers({
    file: path.join("js", "templates", "templates.js"),
    injected: {
        SECTIONS: p17Constants.get("SECTIONS"),
        IMAGE_SECTIONS: p17Constants.get("IMAGE_SECTIONS"),
        escapeAttr: p17Utils.get("escapeAttr"),
        escapeHTML: p17Utils.get("escapeHTML"),
        nfs: function () { return { existsSync: function () { return false; } }; },
        allTemplates: [],
        showToast: function () { },
        rootPath: "",
    },
});

const renderTemplateCardMarkup = p17Templates.get("renderTemplateCardMarkup");
const escapeTemplateCardAttribute = p17Templates.get("escapeTemplateCardAttribute");
if (typeof renderTemplateCardMarkup !== "function" || typeof escapeTemplateCardAttribute !== "function") {
    throw new Error("Property 17 requires the shared card markup helpers from js/templates/templates.js");
}

// ─── Generators ──────────────────────────────────────────────────────────────

// Fragments that are hostile to attribute serialization or to naive escaping.
const p17HostileFragmentArb = fc.constantFrom(
    "\"", "'", "&", "<", ">", "&amp;", "&#39;", "&quot;", "&lt;tpl&gt;",
    "a\"b'c", "<img src=x>", "100%", "%2F", "café", "日本語", "😀", "ß—ok", "tpl-"
);

// Every generated ID embeds its batch position, so a batch never contains a
// duplicate Stable_Media_ID (which the repository rejects by contract).
const p17IdPlanArb = fc.record({
    style: fc.constantFrom("generated", "legacy", "hostile"),
    hostile: p17HostileFragmentArb,
    extra: p17HostileFragmentArb,
    token: fc.stringMatching(/^[A-Za-z0-9]{1,6}$/),
});

function buildP17Id(plan, position) {
    if (plan.style === "legacy") {
        return "legacy-" + encodeURIComponent("C:/media/p17/" + plan.token + position + ".mov") + plan.hostile;
    }
    if (plan.style === "hostile") {
        return position + "-" + plan.hostile + plan.extra;
    }
    return "media-" + position + "-" + plan.token + plan.hostile;
}

const p17ItemPlanArb = fc.record({
    id: p17IdPlanArb,
    // Duplicate display names across items are intentional: identity must come
    // from the Stable_Media_ID, never from the visible name.
    name: fc.constantFrom("clip", "take", "shot", "b-roll"),
    category: fc.constantFrom("video", "image", "audio"),
    mediaType: fc.constantFrom("video", "image"),
    pathStyle: fc.constantFrom("posix", "windows", "trailing"),
});

const p17OperationArb = fc.constantFrom(
    "enqueue-copy",
    "enqueue-thumbnail",
    "enqueue-ffmpeg",
    "duplicate-enqueue",
    "repo-patch",
    "card-patch",
    "reparse-markup"
);

function p17DecoratePath(posixPath, pathStyle) {
    if (pathStyle === "windows") return posixPath.replace(/\//g, "\\");
    if (pathStyle === "trailing") return posixPath + "/";
    return posixPath;
}

function normalizeSchedulerPath(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/\\/g, "/").replace(/\/+$/, "");
}

// A per-run scheduler whose timers are captured instead of scheduled, so keyed
// records stay observable and no real timer escapes the test.
function makeP17Scheduler() {
    const timers = [];
    const scheduler = schedulerModule.createScheduler(null, {
        setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
        clearTimeout: function () { },
    });
    return { scheduler: scheduler, timers: timers };
}

// ─── Property 17 ─────────────────────────────────────────────────────────────
// Feature: media-engine-lag, Property 17: Stable identity survives every projection and DOM escaping
// **Validates: Requirements 5.6, 5.7**
describe("Property 17: Stable identity survives every projection and DOM escaping (Req 5.6, 5.7)", () => {
    test("state, persistence, keyed scheduler records, and card registration all carry the ID assigned at import, and the escaped card attribute parses back to exactly 'tpl-' + that ID", () => {
        fc.assert(
            fc.property(
                fc.array(p17ItemPlanArb, { minLength: 1, maxLength: 5 }),
                fc.array(p17OperationArb, { minLength: 1, maxLength: 6 }),
                (itemPlans, operations) => {
                    // ── Import: allocate one immutable ID per accepted item ──
                    const assignedIds = itemPlans.map(function (plan, position) {
                        return buildP17Id(plan.id, position);
                    });
                    const rawPaths = itemPlans.map(function (plan, position) {
                        return p17DecoratePath("C:/media/p17/lib" + position + "/" + plan.name + position + ".mov", plan.pathStyle);
                    });
                    const entries = itemPlans.map(function (plan, position) {
                        return {
                            id: assignedIds[position],
                            sourcePath: rawPaths[position],
                            folderPath: "C:/media/p17/lib" + position,
                            name: plan.name,
                            displayName: plan.name,
                            category: plan.category,
                            type: "media",
                            mediaType: plan.mediaType,
                            thumbStatus: "placeholder",
                            _isPending: true,
                        };
                    });

                    // ── State: the ledger and the warm-render mirror ─────────
                    const ledger = {}; // keyed by Stable_Media_ID
                    const mirror = []; // the render projection the repository publishes
                    for (let i = 0; i < assignedIds.length; i++) {
                        ledger["$" + assignedIds[i]] = { mediaId: assignedIds[i], stages: [] };
                    }

                    // ── Persistence ──────────────────────────────────────────
                    const persisted = [];
                    const repository = new MediaEntryRepository({
                        storageKey: "compSaver_mediaIndex_p17",
                        allTemplates: mirror,
                        validityKey: null,
                        persist: function (serialized) { persisted.push(serialized); },
                    });
                    const commit = repository.commitOptimisticBatch(entries);
                    expect(commit.ok).toBe(true);

                    // ── DOM: real markup through the real keyed helper ───────
                    const document = createMiniDocument();
                    const grid = document.createElement("div");
                    document.body.appendChild(grid);
                    const failures = [];
                    const cards = new KeyedMediaCardHelper({
                        document: document,
                        renderCardMarkup: renderTemplateCardMarkup,
                        onFailedUpdate: function (reason) { failures.push(reason); },
                    });
                    const inserted = cards.insertBatch(repository.snapshot(), grid);
                    expect(inserted.ok).toBe(true);
                    expect(inserted.ids).toEqual(assignedIds);

                    // ── Scheduler ────────────────────────────────────────────
                    const run = makeP17Scheduler();
                    const laneForStage = {
                        copy: "filesystem",
                        thumbnail: "thumbnail",
                        ffmpeg: "ffmpeg",
                    };
                    const handles = {}; // "<id>|<stage>" -> canonical handle

                    function enqueueStage(id, rawPath, stage, pathSpelling) {
                        const handle = run.scheduler.enqueue(laneForStage[stage], function () { }, {
                            stage: stage,
                            mediaId: id,
                            sourcePath: pathSpelling,
                            owner: id,
                        });
                        // (5.6) The keyed record is derived from the assigned ID.
                        expect(handle.key).toBe(stage + "|" + id + "|" + normalizeSchedulerPath(rawPath));
                        expect(handle.lane).toBe(laneForStage[stage]);
                        const slot = id + "\u0000" + stage;
                        if (Object.prototype.hasOwnProperty.call(handles, slot)) {
                            // A duplicate stage+ID+path request resolves to the
                            // one canonical record for that identity.
                            expect(handle).toBe(handles[slot]);
                        } else {
                            handles[slot] = handle;
                        }
                        ledger["$" + id].stages.push(stage);
                        return handle;
                    }

                    // Assert the identity of every surface for one item.
                    function verifyIdentity(position) {
                        const id = assignedIds[position];
                        const expectedDomId = "tpl-" + id;

                        // state — ledger key and the published render mirror
                        expect(Object.prototype.hasOwnProperty.call(ledger, "$" + id)).toBe(true);
                        expect(ledger["$" + id].mediaId).toBe(id);
                        expect(mirror[position].id).toBe(id);

                        // persistence — snapshot order, keyed lookup, path
                        // lookup, and the serialized payload
                        const snapshot = repository.snapshot();
                        expect(snapshot[position].id).toBe(id);
                        expect(repository.getById(id).id).toBe(id);
                        expect(repository.getBySourcePath(rawPaths[position]).id).toBe(id);
                        const envelope = JSON.parse(persisted[persisted.length - 1]);
                        expect(envelope.entries[position].id).toBe(id);

                        // DOM — the escaped attribute parses back to the exact
                        // concatenation of "tpl-" and the Stable_Media_ID (5.7)
                        const markup = renderTemplateCardMarkup(snapshot[position], "media", []);
                        const escaped = escapeTemplateCardAttribute(expectedDomId);
                        expect(escaped.indexOf("\"")).toBe(-1); // cannot terminate the attribute
                        expect(markup.indexOf(" id=\"" + escaped + "\"")).toBeGreaterThan(-1);

                        const parsed = parseSingleElement(markup);
                        expect(parsed.getAttribute("id")).toBe(expectedDomId);
                        expect(parsed.id).toBe(expectedDomId);
                        expect(parsed.id.substring(0, 4)).toBe("tpl-");
                        expect(parsed.id.substring(4)).toBe(id);

                        // card registration — the live registered card is the
                        // single element addressable by that parsed identity
                        const attached = document.getElementById(expectedDomId);
                        expect(attached).toBe(inserted.cards[position]);
                        expect(attached.id).toBe(expectedDomId);
                        expect(document.querySelectorAll("#" + expectedDomId).length).toBe(1);
                    }

                    for (let i = 0; i < assignedIds.length; i++) verifyIdentity(i);

                    // ── Operation sequence: identity holds after each step ───
                    for (let step = 0; step < operations.length; step++) {
                        const operation = operations[step];
                        for (let i = 0; i < assignedIds.length; i++) {
                            const id = assignedIds[i];

                            if (operation === "enqueue-copy") {
                                enqueueStage(id, rawPaths[i], "copy", rawPaths[i]);
                            } else if (operation === "enqueue-thumbnail") {
                                enqueueStage(id, rawPaths[i], "thumbnail", rawPaths[i]);
                            } else if (operation === "enqueue-ffmpeg") {
                                enqueueStage(id, rawPaths[i], "ffmpeg", rawPaths[i]);
                            } else if (operation === "duplicate-enqueue") {
                                // Same identity, differently spelled path.
                                enqueueStage(id, rawPaths[i], "thumbnail", rawPaths[i]);
                                enqueueStage(id, rawPaths[i], "thumbnail", rawPaths[i].replace(/\//g, "\\") + "/");
                            } else if (operation === "repo-patch") {
                                const patched = repository.patchById(id, {
                                    thumbStatus: "ready",
                                    thumbFile: "thumb-" + i + "-" + step + ".png",
                                    _isPending: false,
                                });
                                expect(patched.ok).toBe(true);
                                expect(repository.getById(id).id).toBe(id);
                                // The assigned ID is immutable across projections.
                                const rejected = repository.patchById(id, { id: id + "-mutated" });
                                expect(rejected.ok).toBe(false);
                                expect(repository.getById(id + "-mutated")).toBe(null);
                            } else if (operation === "card-patch") {
                                const cardPatch = cards.patchById(id, {
                                    thumbnail: "C:/media/p17/thumbs/t" + i + ".png",
                                    thumbStatus: "ready",
                                });
                                expect(cardPatch.ok).toBe(true);
                                expect(cardPatch.id).toBe(id);
                                expect(cardPatch.card.id).toBe("tpl-" + id);
                                expect(cardPatch.card).toBe(inserted.cards[i]);
                            } else if (operation === "reparse-markup") {
                                const reparsed = parseSingleElement(
                                    renderTemplateCardMarkup(repository.getById(id), "media", [])
                                );
                                expect(reparsed.id).toBe("tpl-" + id);
                            }

                            verifyIdentity(i);
                        }
                    }

                    // No projection ever reported a failed keyed card update.
                    expect(failures).toEqual([]);

                    // Identity is still intact after every operation, and the
                    // set of identities is exactly the set assigned at import.
                    const finalIds = repository.snapshot().map(function (entry) { return entry.id; });
                    expect(finalIds).toEqual(assignedIds);
                    expect(mirror.map(function (entry) { return entry.id; })).toEqual(assignedIds);
                    expect(Object.keys(ledger).sort()).toEqual(
                        assignedIds.map(function (id) { return "$" + id; }).sort()
                    );

                    run.scheduler.dispose();
                    cards.dispose();
                }
            ),
            { numRuns: 120 }
        );
    });
});

/**
 * Property 22 — Terminal updates preserve committed media semantics.
 *
 * Feature: media-engine-lag — Task 7.6
 * Validates: Requirements 7.2
 *
 * What is under test
 * ------------------
 * The real terminal-settlement write path, end to end:
 *
 *   js/core/fastMediaEngine.js
 *     `MediaWorkCoordinator.prototype._completionFields` — the production
 *        computation of the repository patch applied when an item reaches a
 *        Terminal_State (thumbnail / Proxy / status / copied-media fields only)
 *     `MediaWorkCoordinator.prototype._cardFields`       — the production card patch
 *     `MediaImportCoordinator.prototype._counts`         — the production aggregate
 *        category count published after membership changes
 *
 *   js/core/persistence.js
 *     `MediaEntryRepository.commitOptimisticBatch` / `patchById` / `snapshot` /
 *     `getById` — the real durable commit and keyed patch merge
 *
 * Each run commits a batch of media entries that carry arbitrary committed
 * metadata (top-level unknown fields, a retained legacy `metadata` object,
 * display names shared across items, repeated categories) plus optional
 * committed thumbnail/Proxy/status values, then settles every item through the
 * real completion-field computation and the real keyed repository patch.
 *
 * Requirement 7.2 is then checked on each settled item:
 *   - every committed Media_Entry metadata value is retained, except the
 *     thumbnail, Proxy, and status values produced by completed background work
 *     (the patch may only touch that allow-list, and may only change the keys
 *     it actually carries),
 *   - the item appears exactly once in its committed category and exactly once
 *     in the aggregate category count, which stays exact across settlement,
 *   - an existing Proxy reference is retained whenever the referenced Proxy
 *     remains available.
 *
 * Proxy generation only happens when no playable Proxy exists (Requirement 6.9),
 * so a run whose committed Proxy remains available produces no new Proxy path;
 * runs with a missing/unavailable Proxy do produce one, which is where a new
 * reference is allowed to appear.
 *
 * Pure logic only — no filesystem writes, no browser, no After Effects.
 */

const nodeFs = require("fs");
const nodeVm = require("vm");

const P22_ROOT = path.resolve(__dirname, "..");
const P22_ENGINE_SCRIPT = new nodeVm.Script(
    nodeFs.readFileSync(path.join(P22_ROOT, "js", "core", "fastMediaEngine.js"), "utf8"),
    { filename: "fastMediaEngine.js" }
);

// The only fields terminal settlement is allowed to write: the thumbnail,
// Proxy, and status values produced by completed background work, plus the
// copied-media references produced by the completed copy stage.
const P22_BACKGROUND_WORK_FIELDS = [
    "thumbStatus", "terminalState", "derivativeStatus", "updatedAt", "_isPending",
    "thumbnail", "thumbnailPath", "proxyFile", "mediaFile", "mainFile", "fileSize"
];

function p22IsBackgroundWorkField(key) {
    return P22_BACKGROUND_WORK_FIELDS.indexOf(key) > -1;
}

// A media-engine window with no real filesystem, DOM, or timers in play: only
// the pure field-computation and count helpers are exercised from it.
function loadP22Engine() {
    function unexpected() {
        throw new Error("Property 22 exercises pure field computation, not filesystem work");
    }
    const context = {
        window: {
            rootPath: "C:/library",
            addEventListener: function () { },
            removeEventListener: function () { },
            URL: { createObjectURL: function () { return ""; }, revokeObjectURL: function () { } },
        },
        document: {
            getElementById: function () { return null; },
            querySelector: function () { return null; },
            querySelectorAll: function () { return []; },
            createElement: function () { throw new Error("terminal settlement must not create media elements"); },
        },
        performance: { now: function () { return 0; } },
        console: { log: function () { }, warn: function () { }, error: function () { } },
        require: function (name) {
            if (name === "fs") {
                return {
                    promises: {
                        mkdir: async function () { return undefined; },
                        stat: async function () { return { size: 0 }; },
                        unlink: async function () { return undefined; },
                        writeFile: async function () { return undefined; },
                        copyFile: async function () { return undefined; },
                    },
                    createReadStream: unexpected,
                    createWriteStream: unexpected,
                    existsSync: function () { return false; },
                    statSync: function () { return { size: 0 }; },
                };
            }
            if (name === "path") return path;
            throw new Error("Unexpected require: " + name);
        },
        showToast: function () { },
        getLibraryIndex: function () { return null; },
        setTimeout: setTimeout, clearTimeout: clearTimeout,
        setInterval: setInterval, clearInterval: clearInterval,
        Promise: Promise, Date: Date, Buffer: Buffer,
        Image: function () { },
        btoa: function () { return ""; },
        unescape: function (value) { return value; },
        encodeURIComponent: encodeURIComponent,
    };
    context.window.window = context.window;
    nodeVm.createContext(context);
    P22_ENGINE_SCRIPT.runInContext(context);
    if (typeof context.window.MediaWorkCoordinator !== "function" ||
        typeof context.window.MediaImportCoordinator !== "function") {
        throw new Error("Property 22 requires MediaWorkCoordinator and MediaImportCoordinator from the media engine");
    }
    return context.window;
}

const p22Engine = loadP22Engine();

// ─── Generators for Property 22 ──────────────────────────────────────────────

// Repeated categories (and one empty category) so aggregate counts exceed one
// and the "exactly once" clause has something to violate.
const p22CategoryArb = fc.constantFrom("Imported", "Imported", "B-Roll", "Titles", "");

const p22ItemPlanArb = fc.record({
    category: p22CategoryArb,
    // Duplicate display names are intentional: identity and membership must
    // never be derived from the visible name.
    displayName: fc.constantFrom("clip", "take", "shot"),
    section: fc.constantFrom("footage", "images"),
    isVideo: fc.boolean(),
    pathStyle: fc.constantFrom("posix", "windows", "trailing"),
    hasLegacyMetadata: fc.boolean(),
    committedThumbnail: fc.boolean(),
    committedStatus: fc.constantFrom("placeholder", "pending", "ready"),
    proxy: fc.constantFrom("none", "available", "unavailable"),
    unknownTop: fc.dictionary(unknownKeyArb, jsonValueArb, { maxKeys: 3 }),
    unknownLegacy: fc.dictionary(unknownKeyArb, jsonValueArb, { maxKeys: 3 }),
    // Inputs to the real completion-field computation.
    terminal: fc.constantFrom("ready", "failed", "derivative-unavailable"),
    copyResult: fc.constantFrom("none", "ok"),
    fileSize: fc.integer({ min: 0, max: 500000 }),
    thumbnailResult: fc.constantFrom("none", "ok", "failed", "unavailable"),
    ffmpegResult: fc.constantFrom("none", "ok-thumbnail", "ok-proxy-only", "failed"),
});

function p22DecoratePath(posixPath, pathStyle) {
    if (pathStyle === "windows") return posixPath.replace(/\//g, "\\");
    if (pathStyle === "trailing") return posixPath + "/";
    return posixPath;
}

function buildP22Entry(plan, position) {
    const ext = plan.isVideo ? ".mp4" : ".png";
    const entry = {
        id: "media-p22-" + position,
        sourcePath: p22DecoratePath("C:/originals/p22/lib" + position + "/asset" + position + ext, plan.pathStyle),
        folderPath: "C:/library/" + plan.section + "/media-p22-" + position,
        name: plan.displayName + position,
        displayName: plan.displayName,
        category: plan.category,
        section: plan.section,
        type: "media",
        mediaType: plan.isVideo ? "video" : "image",
        createdAt: "2025-01-0" + ((position % 9) + 1) + "T00:00:00.000Z",
        thumbStatus: plan.committedStatus,
        terminalState: "pending",
        _isPending: true,
    };
    Object.keys(plan.unknownTop).forEach(function (key) {
        entry[key] = plan.unknownTop[key];
    });
    if (plan.committedThumbnail) {
        entry.thumbnail = "C:/library/" + plan.section + "/media-p22-" + position + "/committed-thumb.png";
        entry.thumbnailPath = entry.thumbnail;
    }
    if (plan.proxy !== "none") {
        entry.proxyFile = "C:/library/" + plan.section + "/media-p22-" + position + "/committed-proxy.mp4";
    }
    if (plan.hasLegacyMetadata) {
        const metadata = { codec: plan.isVideo ? "prores" : "png", legacyNote: "kept" };
        Object.keys(plan.unknownLegacy).forEach(function (key) {
            metadata[key] = plan.unknownLegacy[key];
        });
        entry.metadata = metadata;
    }
    return entry;
}

// The production item record the completion-field computation reads, with the
// completed background results the generated plan produced.
function buildP22Item(plan, entry, position) {
    const ext = plan.isVideo ? ".mp4" : ".png";
    const folder = "C:/library/" + plan.section + "/media-p22-" + position;
    const completedResults = {};
    if (plan.copyResult === "ok") {
        completedResults.copy = { ok: true, fileSize: plan.fileSize };
    }
    if (plan.thumbnailResult === "ok") {
        completedResults.thumbnail = { ok: true, path: folder + "/thumbnail.png" };
    } else if (plan.thumbnailResult === "unavailable") {
        completedResults.thumbnail = { ok: false, status: "unavailable" };
    } else if (plan.thumbnailResult === "failed") {
        completedResults.thumbnail = { ok: true };
    }
    if (plan.ffmpegResult === "ok-thumbnail") {
        completedResults.ffmpeg = { ok: true, thumbnailPath: folder + "/ffmpeg-thumbnail.png" };
        // A Proxy is only generated when no playable Proxy exists (Req 6.9).
        if (plan.proxy !== "available") completedResults.ffmpeg.proxyPath = folder + "/generated-proxy.mp4";
    } else if (plan.ffmpegResult === "ok-proxy-only") {
        completedResults.ffmpeg = { ok: true };
        if (plan.proxy !== "available") completedResults.ffmpeg.proxyPath = folder + "/generated-proxy.mp4";
    } else if (plan.ffmpegResult === "failed") {
        completedResults.ffmpeg = { ok: false };
    }
    return {
        id: entry.id,
        isVideo: plan.isVideo,
        fileName: "asset" + position + ext,
        destinationFolder: folder,
        destinationMedia: folder + "/asset" + position + ext,
        destinationThumbnail: folder + "/thumbnail.png",
        completedResults: completedResults,
    };
}

// Reference aggregate category count, independent of the implementation.
function p22ReferenceCounts(entries) {
    const counts = {};
    for (let i = 0; i < entries.length; i++) {
        const category = entries[i] && entries[i].category !== undefined ? String(entries[i].category) : "";
        counts[category] = (counts[category] || 0) + 1;
    }
    return counts;
}

// ─── Property 22 ─────────────────────────────────────────────────────────────
// Feature: media-engine-lag, Property 22: Terminal updates preserve committed media semantics
// **Validates: Requirements 7.2**
describe("Property 22: Terminal updates preserve committed media semantics (Req 7.2)", () => {
    test("reaching a terminal state retains every committed metadata value except the thumbnail/Proxy/status values produced by completed background work, keeps the item exactly once in its committed category and category count, and retains an available Proxy reference", () => {
        fc.assert(
            fc.property(
                fc.array(p22ItemPlanArb, { minLength: 1, maxLength: 5 }),
                (plans) => {
                    const entries = plans.map(buildP22Entry);

                    // ── One durable commit of the optimistic batch ───────────
                    const mirror = [];
                    const persisted = [];
                    const repository = new MediaEntryRepository({
                        storageKey: "compSaver_mediaIndex_p22",
                        allTemplates: mirror,
                        validityKey: "p22-key",
                        persist: function (serialized) { persisted.push(serialized); },
                    });
                    const commit = repository.commitOptimisticBatch(entries);
                    expect(commit.ok).toBe(true);

                    // Real coordinators: the production terminal-field
                    // computation and the production aggregate count.
                    const work = new p22Engine.MediaWorkCoordinator({ repository: repository });
                    const imports = new p22Engine.MediaImportCoordinator({
                        repository: repository,
                        requestAnimationFrame: function () { return 1; },
                        cancelAnimationFrame: function () { },
                        setTimeout: function () { return 1; },
                        clearTimeout: function () { },
                    });

                    const committedById = {};
                    repository.snapshot().forEach(function (entry) {
                        committedById["$" + entry.id] = jsonClone(entry);
                    });
                    const committedIds = repository.snapshot().map(function (entry) { return entry.id; });
                    const referenceCounts = p22ReferenceCounts(repository.snapshot());
                    expect(imports._counts()).toEqual(referenceCounts);

                    for (let i = 0; i < plans.length; i++) {
                        const plan = plans[i];
                        const id = committedIds[i];
                        const committed = committedById["$" + id];
                        const item = buildP22Item(plan, committed, i);
                        const others = jsonClone(repository.snapshot().filter(function (entry) {
                            return entry.id !== id;
                        }));

                        // ── Real terminal settlement patch ──────────────────
                        const fields = work._completionFields(item, plan.terminal);
                        const patchResult = repository.patchById(id, fields);
                        expect(patchResult.ok).toBe(true);

                        const settled = repository.getById(id);
                        expect(!!settled).toBe(true);

                        // (7.2) Settlement may only write thumbnail, Proxy, and
                        // status values produced by completed background work.
                        Object.keys(fields).forEach(function (key) {
                            expect(p22IsBackgroundWorkField(key)).toBe(true);
                        });

                        // (7.2) Every other committed metadata value is retained
                        // exactly, including the retained legacy object and every
                        // unrecognized committed field.
                        Object.keys(committed).forEach(function (key) {
                            expect(hasOwn(settled, key)).toBe(true);
                            if (!hasOwn(fields, key)) {
                                expect(settled[key]).toEqual(committed[key]);
                            }
                        });
                        expect(settled.id).toBe(id);
                        expect(settled.displayName).toEqual(committed.displayName);
                        expect(settled.name).toEqual(committed.name);
                        expect(settled.createdAt).toEqual(committed.createdAt);
                        expect(settled.sourcePath).toEqual(committed.sourcePath);
                        expect(settled.section).toEqual(committed.section);
                        expect(settled.mediaType).toEqual(committed.mediaType);
                        if (hasOwn(committed, "metadata")) {
                            expect(settled.metadata).toEqual(committed.metadata);
                        }

                        // (7.2) The card patch stays inside the same allow-list.
                        const cardPatch = work._cardFields(item, fields, plan.terminal);
                        Object.keys(cardPatch).forEach(function (key) {
                            expect(p22IsBackgroundWorkField(key)).toBe(true);
                        });

                        // (7.2) The item is still in its committed category, and
                        // appears there exactly once.
                        const snapshot = repository.snapshot();
                        expect(settled.category).toEqual(committed.category);
                        const sameId = snapshot.filter(function (entry) { return entry.id === id; });
                        expect(sameId.length).toBe(1);
                        expect(sameId[0].category).toEqual(committed.category);
                        expect(snapshot.length).toBe(committedIds.length);
                        expect(snapshot.map(function (entry) { return entry.id; })).toEqual(committedIds);

                        // (7.2) The aggregate category count is unchanged and
                        // counts this item exactly once.
                        const counts = imports._counts();
                        expect(counts).toEqual(referenceCounts);
                        expect(counts).toEqual(p22ReferenceCounts(snapshot));
                        const categoryKey = committed.category === undefined ? "" : String(committed.category);
                        expect(counts[categoryKey]).toBe(snapshot.filter(function (entry) {
                            return String(entry.category === undefined ? "" : entry.category) === categoryKey;
                        }).length);

                        // (7.2) An existing Proxy reference survives settlement
                        // while the referenced Proxy remains available.
                        if (plan.proxy === "available") {
                            expect(settled.proxyFile).toBe(committed.proxyFile);
                        } else if (item.completedResults.ffmpeg && item.completedResults.ffmpeg.proxyPath) {
                            expect(settled.proxyFile).toBe(item.completedResults.ffmpeg.proxyPath);
                        } else if (hasOwn(committed, "proxyFile")) {
                            expect(settled.proxyFile).toBe(committed.proxyFile);
                        }

                        // Settling one item never disturbs another committed item.
                        expect(snapshot.filter(function (entry) { return entry.id !== id; })).toEqual(others);
                    }

                    // Every item settled, order and membership intact.
                    const finalSnapshot = repository.snapshot();
                    expect(finalSnapshot.map(function (entry) { return entry.id; })).toEqual(committedIds);
                    expect(mirror.map(function (entry) { return entry.id; })).toEqual(committedIds);
                    expect(p22ReferenceCounts(finalSnapshot)).toEqual(referenceCounts);

                    imports.dispose();
                    work.dispose();
                }
            ),
            { numRuns: 120 }
        );
    });
});

/**
 * Property 24 — Picker cancellation is observationally inert.
 *
 * Feature: media-engine-lag — Task 7.8
 * Validates: Requirements 7.4
 *
 * What is under test
 * ------------------
 * The real production picker path of js/core/fastMediaEngine.js, driven exactly
 * the way the panel drives it:
 *
 *   `FastMedia.init()`            — wires the real `#btn-import-file` /
 *                                   `#btn-import-folder` click handlers and
 *                                   builds the real production media runtime
 *                                   (real `MediaEntryRepository`, real
 *                                   `KeyedMediaCardHelper`, real
 *                                   `MediaImportCoordinator` + `MediaWorkCoordinator`)
 *   `openMediaPicker(isFolder)`   — the real picker entry point reached by a
 *                                   real click, including
 *                                   `beginProductionScenario` and the
 *                                   `finishProductionScenario({cancelled:true})`
 *                                   branch taken when the picker returns no
 *                                   selection
 *
 * Only the environment is faked: an ExtendScript bridge whose `evalScript`
 * hands back a falsy Picker_Result (`""`, `null`, or `undefined`, i.e. the
 * cancel spellings of `if(f) f.fsName; else "";`), a recording scheduler, a
 * recording filesystem, recording timers, and the tests/helpers/miniDom.js
 * document (Jest runs in the "node" environment, so no browser DOM exists).
 *
 * The pre-picker state is produced by real code: one durable
 * `commitOptimisticBatch` through the production repository instance, then one
 * real `KeyedMediaCardHelper.insertBatch` of that committed snapshot into the
 * real section grid. Requirement 7.4 is then checked after each cancellation:
 * Library_Index entry count, entry order, entry values, visible card
 * identities, visible card order, and displayed category counts must all equal
 * their pre-picker values — and no durable write, scheduler job, filesystem
 * call, timer, or category refresh may happen at all.
 */

// ─── Harness for Property 24 ─────────────────────────────────────────────────

const P24_LIBRARY_ROOT = "C:/library";
const P24_GRID_IDS = { footage: "footage-list-container", images: "icon-list-container" };
const P24_PICKER_SCRIPTS = {
    file: 'var f = File.openDialog("Select Media File"); if(f) f.fsName; else "";',
    folder: 'var f = Folder.selectDialog("Select Media Folder"); if(f) f.fsName; else "";',
};

// Deterministic serialization of a miniDom subtree: attribute-name sorted, so a
// re-render that changes nothing textually still compares equal, and any real
// change to a visible card is caught.
function p24Serialize(node) {
    if (!node) return "";
    if (node.nodeType === 3) return node.data;
    const names = Object.keys(node._attributes).sort();
    let out = "<" + node.localName;
    for (let i = 0; i < names.length; i++) out += " " + names[i] + '="' + node._attributes[names[i]] + '"';
    out += ">";
    for (let c = 0; c < node.childNodes.length; c++) out += p24Serialize(node.childNodes[c]);
    return out + "</" + node.localName + ">";
}

// Everything Requirement 7.4 names, read from the live surfaces.
function p24Observe(harness) {
    const snapshot = harness.repository.snapshot();
    const cards = harness.grid.children;
    return {
        entryCount: snapshot.length,
        entryOrder: snapshot.map(function (entry) { return entry.id; }),
        entryValues: jsonClone(snapshot),
        mirror: jsonClone(harness.mirror),
        cardIdentities: cards.map(function (card) { return card.id; }),
        cardMarkup: cards.map(p24Serialize),
        cardElements: cards.slice(),
        categoryCounts: p22ReferenceCounts(snapshot),
    };
}

function p24MakeButton() {
    const listeners = [];
    return {
        addEventListener: function (type, listener) { listeners.push({ type: type, listener: listener }); },
        removeEventListener: function (type, listener) {
            for (let i = listeners.length - 1; i >= 0; i--) {
                if (listeners[i].type === type && listeners[i].listener === listener) listeners.splice(i, 1);
            }
        },
        click: function () {
            const snapshot = listeners.slice();
            for (let i = 0; i < snapshot.length; i++) {
                if (snapshot[i].type === "click") snapshot[i].listener({ stopPropagation: function () { } });
            }
        },
    };
}

// One media-engine realm per run: the engine keeps module-level runtime state,
// so a fresh realm is the only way to observe a fresh pre-picker library.
function p24LoadEngine(section) {
    const recorder = {
        fsCalls: [],
        jobs: [],
        cancelCalls: [],
        timers: [],
        persisted: [],
        refreshes: [],
        pickerScripts: [],
        pickerCallbacks: [],
        toasts: [],
    };
    const captured = { repository: null, cards: null };

    const miniDocument = createMiniDocument();
    const grid = miniDocument.createElement("div");
    grid.id = P24_GRID_IDS[section];
    miniDocument.body.appendChild(grid);

    const buttons = {
        "btn-import-file": p24MakeButton(),
        "btn-import-folder": p24MakeButton(),
    };

    const engineDocument = {
        getElementById: function (id) {
            if (hasOwn(buttons, id)) return buttons[id];
            return miniDocument.getElementById(id);
        },
        querySelector: function (selector) { return miniDocument.querySelector(selector); },
        querySelectorAll: function (selector) { return miniDocument.querySelectorAll(selector); },
        createElement: function (tagName) { return miniDocument.createElement(tagName); },
        createDocumentFragment: function () { return miniDocument.createDocumentFragment(); },
        addEventListener: function () { },
        removeEventListener: function () { },
        body: miniDocument.body,
        documentElement: miniDocument.documentElement,
    };

    function recordFs(name) {
        return function () {
            recorder.fsCalls.push(name);
            throw new Error("Property 24 must not touch the filesystem (" + name + ")");
        };
    }
    const fakeFs = {
        existsSync: function () { recorder.fsCalls.push("existsSync"); return false; },
        statSync: recordFs("statSync"),
        stat: recordFs("stat"),
        readdir: recordFs("readdir"),
        createReadStream: recordFs("createReadStream"),
        createWriteStream: recordFs("createWriteStream"),
        promises: {
            mkdir: function () { recorder.fsCalls.push("mkdir"); return Promise.resolve(); },
            stat: function () { recorder.fsCalls.push("promiseStat"); return Promise.resolve({ size: 0 }); },
            readdir: function () { recorder.fsCalls.push("promiseReaddir"); return Promise.resolve([]); },
            unlink: function () { recorder.fsCalls.push("unlink"); return Promise.resolve(); },
            writeFile: function () { recorder.fsCalls.push("writeFile"); return Promise.resolve(); },
            copyFile: function () { recorder.fsCalls.push("copyFile"); return Promise.resolve(); },
        },
    };

    const fakeScheduler = {
        enqueue: function (lane, worker, options) {
            recorder.jobs.push({ lane: lane, stage: options && options.stage, mediaId: options && options.mediaId });
            return { promise: Promise.resolve(), lane: lane, cancel: function () { return false; } };
        },
        defer: function (lane, delay, worker, options) { return this.enqueue(lane, worker, options); },
        cancelByOwner: function (owner) { recorder.cancelCalls.push(owner); return true; },
        snapshot: function () {
            return {
                lanes: {
                    filesystem: { pending: 0, active: 0 },
                    thumbnail: { pending: 0, active: 0 },
                    ffmpeg: { pending: 0, active: 0 },
                },
                processes: 0,
            };
        },
    };

    // The real repository and the real keyed card helper, captured on
    // construction so the test can read the exact production instances.
    function CapturingRepository(options) {
        const merged = {};
        Object.keys(options || {}).forEach(function (key) { merged[key] = options[key]; });
        merged.storageKey = "compSaver_mediaIndex_p24";
        merged.persist = function (serialized) { recorder.persisted.push(serialized); };
        captured.repository = new MediaEntryRepository(merged);
        return captured.repository;
    }
    function CapturingCardHelper(options) {
        captured.cards = new KeyedMediaCardHelper(options);
        return captured.cards;
    }

    const mirror = [];
    const context = {
        window: {
            rootPath: P24_LIBRARY_ROOT,
            allTemplates: mirror,
            MediaEntryRepository: CapturingRepository,
            KeyedMediaCardHelper: CapturingCardHelper,
            Scheduler: fakeScheduler,
            renderTemplateCardMarkup: renderTemplateCardMarkup,
            addEventListener: function () { },
            removeEventListener: function () { },
            URL: { createObjectURL: function () { return ""; }, revokeObjectURL: function () { } },
        },
        document: engineDocument,
        csInterface: {
            evalScript: function (script, callback) {
                recorder.pickerScripts.push(script);
                recorder.pickerCallbacks.push(callback);
            },
        },
        currentSection: section,
        getLibraryIndex: function () { return null; },
        buildCategoryTabs: function () { recorder.refreshes.push("tabs"); },
        buildCategoryPanel: function () { recorder.refreshes.push("panel"); },
        updateCount: function () { recorder.refreshes.push("count"); },
        showToast: function (message) { recorder.toasts.push(message); },
        performance: { now: function () { return 0; } },
        console: { log: function () { }, warn: function () { }, error: function () { } },
        require: function (name) {
            if (name === "fs") return fakeFs;
            if (name === "path") return path;
            throw new Error("Unexpected require: " + name);
        },
        setTimeout: function (handler, delay) { recorder.timers.push({ handler: handler, delay: delay }); return recorder.timers.length; },
        clearTimeout: function () { },
        setInterval: function (handler, delay) { recorder.timers.push({ handler: handler, delay: delay }); return recorder.timers.length; },
        clearInterval: function () { },
        Promise: Promise, Date: Date, Buffer: Buffer,
        Image: function () { },
        btoa: function () { return ""; },
        unescape: function (value) { return value; },
        encodeURIComponent: encodeURIComponent,
    };
    context.window.window = context.window;
    nodeVm.createContext(context);
    P22_ENGINE_SCRIPT.runInContext(context);
    if (!context.window.FastMedia || typeof context.window.FastMedia.init !== "function") {
        throw new Error("Property 24 requires the production FastMedia entry points");
    }

    return {
        engine: context.window,
        buttons: buttons,
        document: miniDocument,
        grid: grid,
        mirror: mirror,
        recorder: recorder,
        captured: captured,
    };
}

// ─── Generators for Property 24 ──────────────────────────────────────────────

const p24EntryPlanArb = fc.record({
    // Repeated categories (and one empty category) so displayed counts exceed
    // one per category and an off-by-one recount would be visible.
    category: fc.constantFrom("Imported", "Imported", "B-Roll", "Stills", ""),
    // Duplicate display names are intentional: card identity comes from the
    // Stable_Media_ID, never from the visible name.
    displayName: fc.constantFrom("clip", "take", "shot"),
    isVideo: fc.boolean(),
    favorite: fc.boolean(),
    hasThumbnail: fc.boolean(),
    pathStyle: fc.constantFrom("posix", "windows", "trailing"),
    hasLegacyMetadata: fc.boolean(),
    unknown: fc.dictionary(unknownKeyArb, jsonValueArb, { maxKeys: 3 }),
});

function buildP24Entry(plan, position) {
    const ext = plan.isVideo ? ".mp4" : ".png";
    const folder = P24_LIBRARY_ROOT + "/media-p24-" + position;
    const entry = {
        id: "media-p24-" + position,
        sourcePath: p22DecoratePath("C:/originals/p24/lib" + position + "/asset" + position + ext, plan.pathStyle),
        folderPath: folder,
        name: plan.displayName + position,
        displayName: plan.displayName,
        category: plan.category,
        type: "media",
        mediaType: plan.isVideo ? "video" : "image",
        mediaFile: "asset" + position + ext,
        favorite: plan.favorite,
        thumbStatus: "ready",
        terminalState: "ready",
        _isPending: false,
    };
    Object.keys(plan.unknown).forEach(function (key) { entry[key] = plan.unknown[key]; });
    if (plan.hasThumbnail) {
        entry.thumbnail = folder + "/thumbnail.png";
        entry.thumbnailPath = entry.thumbnail;
    }
    if (plan.hasLegacyMetadata) {
        entry.metadata = { codec: plan.isVideo ? "h264" : "png", legacyNote: "kept" };
    }
    return entry;
}

const p24CancellationArb = fc.record({
    isFolder: fc.boolean(),
    // The falsy Picker_Result spellings the production callback treats as a
    // cancellation (`if(f) f.fsName; else "";`).
    result: fc.constantFrom("", null, undefined),
});

// ─── Property 24 ─────────────────────────────────────────────────────────────
// Feature: media-engine-lag, Property 24: Picker cancellation is observationally inert
// **Validates: Requirements 7.4**
describe("Property 24: Picker cancellation is observationally inert (Req 7.4)", () => {
    test("cancelling the real file or folder picker without a selection leaves the Library_Index entry count, order, and values, the visible card identities and order, and the displayed category counts exactly equal to their pre-picker values", () => {
        fc.assert(
            fc.property(
                fc.array(p24EntryPlanArb, { minLength: 1, maxLength: 5 }),
                fc.array(p24CancellationArb, { minLength: 1, maxLength: 3 }),
                fc.constantFrom("footage", "images"),
                (plans, cancellations, section) => {
                    const harness = p24LoadEngine(section);
                    const engine = harness.engine;

                    // ── Panel startup: real click wiring + real runtime ──────
                    expect(engine.FastMedia.init()).toBe(true);
                    const repository = harness.captured.repository;
                    const cards = harness.captured.cards;
                    expect(repository instanceof MediaEntryRepository).toBe(true);
                    expect(cards instanceof KeyedMediaCardHelper).toBe(true);

                    // ── Pre-picker library: one real durable commit ──────────
                    const entries = plans.map(buildP24Entry);
                    const commit = repository.commitOptimisticBatch(entries);
                    expect(commit.ok).toBe(true);

                    // ── Pre-picker grid: real keyed card insertion ───────────
                    const committed = repository.snapshot();
                    const inserted = cards.insertBatch(committed, harness.grid);
                    expect(inserted.ok).toBe(true);
                    expect(harness.grid.children.length).toBe(entries.length);

                    // The values observed immediately before the picker opens.
                    const before = p24Observe({
                        repository: repository,
                        grid: harness.grid,
                        mirror: harness.mirror,
                    });
                    const mirrorRef = harness.mirror;
                    const displayedCounts = jsonClone(before.categoryCounts);
                    expect(before.entryCount).toBe(entries.length);
                    expect(before.cardIdentities).toEqual(
                        before.entryOrder.map(function (id) { return "tpl-" + id; })
                    );

                    // Only picker activity is measured from here on.
                    const recorder = harness.recorder;
                    recorder.fsCalls.length = 0;
                    recorder.jobs.length = 0;
                    recorder.cancelCalls.length = 0;
                    recorder.timers.length = 0;
                    recorder.persisted.length = 0;
                    recorder.refreshes.length = 0;

                    for (let step = 0; step < cancellations.length; step++) {
                        const plan = cancellations[step];
                        const button = plan.isFolder
                            ? harness.buttons["btn-import-folder"]
                            : harness.buttons["btn-import-file"];

                        // ── The picker opens through the real click handler ──
                        button.click();
                        expect(recorder.pickerScripts.length).toBe(step + 1);
                        expect(recorder.pickerScripts[step]).toBe(
                            plan.isFolder ? P24_PICKER_SCRIPTS.folder : P24_PICKER_SCRIPTS.file
                        );

                        // ── The picker returns with no selection ────────────
                        const settle = recorder.pickerCallbacks[step];
                        expect(typeof settle).toBe("function");
                        settle(plan.result);

                        const after = p24Observe({
                            repository: repository,
                            grid: harness.grid,
                            mirror: harness.mirror,
                        });

                        // (7.4) Library_Index entry count, order, and values.
                        expect(after.entryCount).toBe(before.entryCount);
                        expect(after.entryOrder).toEqual(before.entryOrder);
                        expect(after.entryValues).toEqual(before.entryValues);
                        for (let i = 0; i < before.entryOrder.length; i++) {
                            const id = before.entryOrder[i];
                            expect(repository.getById(id)).toEqual(before.entryValues[i]);
                            expect(repository.getBySourcePath(before.entryValues[i].sourcePath))
                                .toEqual(before.entryValues[i]);
                        }
                        expect(repository.lastError()).toBe(null);

                        // The warm-render mirror is the same array, unchanged.
                        expect(harness.mirror).toBe(mirrorRef);
                        expect(after.mirror).toEqual(before.mirror);

                        // (7.4) Visible card identities and visible card order.
                        expect(after.cardIdentities).toEqual(before.cardIdentities);
                        expect(after.cardMarkup).toEqual(before.cardMarkup);
                        expect(after.cardElements.length).toBe(before.cardElements.length);
                        for (let c = 0; c < before.cardElements.length; c++) {
                            expect(after.cardElements[c]).toBe(before.cardElements[c]);
                            expect(harness.document.getElementById(before.cardIdentities[c]))
                                .toBe(before.cardElements[c]);
                        }

                        // (7.4) Displayed category counts.
                        expect(after.categoryCounts).toEqual(displayedCounts);
                        expect(recorder.refreshes).toEqual([]);

                        // A cancelled picker starts no work of any kind, so
                        // nothing can drift after the observation either.
                        expect(recorder.persisted).toEqual([]);
                        expect(recorder.jobs).toEqual([]);
                        expect(recorder.cancelCalls).toEqual([]);
                        expect(recorder.fsCalls).toEqual([]);
                        expect(recorder.timers).toEqual([]);
                        expect(recorder.pickerScripts.length).toBe(step + 1);
                    }

                    engine.FastMedia.dispose();
                }
            ),
            { numRuns: 120 }
        );
    });
});
