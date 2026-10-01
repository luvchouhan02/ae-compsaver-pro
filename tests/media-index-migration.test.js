/**
 * Media index migration and persistence — example tests
 * =====================================================
 *
 * Focused (non-property) coverage for the real `MediaEntryRepository` from
 * js/core/persistence.js:
 *
 *   - deterministic, injective legacy Stable_Media_ID derivation and
 *     pre-publication collision detection            (Req 5.11)
 *   - conflicting top-level vs nested `metadata` fields: top level wins and
 *     the legacy object is retained                  (Req 5.4, 5.11)
 *   - storage errors returning {ok:false, operation, error} while the last
 *     durable snapshot stays unchanged               (Req 5.13)
 *   - asynchronous validity refresh persisting a new validity key without a
 *     full scan and without any synchronous fs call  (Req 5.13, 7.5)
 *   - warm-render field/path equality after a panel restart
 *                                                    (Req 5.4, 5.5, 7.5)
 *
 * These are example tests only. No fast-check properties live in this file.
 */

const {
    MediaEntryRepository,
    normalizeMediaEntry,
    normalizeFolderPath,
} = require("../js/core/persistence.js");

function jsonClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function makeRepository(options) {
    const opts = options || {};
    const persisted = [];
    const mirror = opts.mirror || [];
    const state = { persistError: null, persistRejection: null };
    const repository = new MediaEntryRepository({
        storageKey: "compSaver_mediaIndex_example",
        entries: opts.entries || [],
        allTemplates: mirror,
        validityKey: opts.validityKey === undefined ? null : opts.validityKey,
        validityPaths: opts.validityPaths || [],
        fs: opts.fs || null,
        persist: function (serialized) {
            if (state.persistError) throw state.persistError;
            if (state.persistRejection) return Promise.reject(state.persistRejection);
            persisted.push(serialized);
            return undefined;
        },
    });
    return { repository: repository, persisted: persisted, mirror: mirror, state: state };
}

// A legacy record: no id, source path recorded only inside `metadata`.
function legacyEntry(sourcePath, extra) {
    const entry = { metadata: { sourcePath: sourcePath } };
    if (extra) {
        Object.keys(extra).forEach(function (key) {
            entry[key] = extra[key];
        });
    }
    return entry;
}

// ─── Deterministic, injective legacy ID derivation (Req 5.11) ─────────────────
describe("legacy Stable_Media_ID derivation (Req 5.11)", () => {
    test("the same legacy entry always derives the same ID across independent loads", () => {
        const raw = { folderPath: "C:\\media\\clip a.mp4" };

        const first = makeRepository({ entries: [jsonClone(raw)] });
        const second = makeRepository({ entries: [jsonClone(raw)] });
        expect(first.repository.commitOptimisticBatch([]).ok).toBe(true);
        expect(second.repository.commitOptimisticBatch([]).ok).toBe(true);

        const firstId = first.repository.snapshot()[0].id;
        expect(firstId).toBe("legacy-" + encodeURIComponent("C:/media/clip a.mp4"));
        expect(second.repository.snapshot()[0].id).toBe(firstId);
        // Direct normalization agrees with the committed migration.
        expect(normalizeMediaEntry(jsonClone(raw)).id).toBe(firstId);
    });

    test("path-variant spellings of one path derive one ID; the ID is addressable before its first commit", () => {
        const variants = [
            "C:/media/clip a.mp4",
            "C:\\media\\clip a.mp4",
            "C:/media/clip a.mp4/",
            "C:\\media\\clip a.mp4\\\\",
        ];
        const ids = variants.map(function (pathValue) {
            return normalizeMediaEntry({ folderPath: pathValue }).id;
        });
        ids.forEach(function (id) {
            expect(id).toBe(ids[0]);
        });

        // A loaded-but-not-yet-recommitted legacy entry is already addressable.
        const loaded = makeRepository({ entries: [legacyEntry("D:\\legacy\\old.mov")] });
        const derivedId = "legacy-" + encodeURIComponent("D:/legacy/old.mov");
        expect(loaded.repository.getById(derivedId)).not.toBe(null);
        expect(loaded.repository.getById(derivedId).id).toBe(derivedId);
        expect(loaded.repository.getBySourcePath("D:/legacy/old.mov")).not.toBe(null);
    });

    test("distinct normalized paths derive distinct IDs", () => {
        const paths = [
            "C:/media/a.mp4",
            "C:/media/b.mp4",
            "C:/media/sub/a.mp4",
            "C:/media/a .mp4",
            "C:/media/ä.mp4",
            "C:/media/a%2Fb.mp4",
            "D:/media/a.mp4",
        ];
        const ids = paths.map(function (pathValue) {
            return normalizeMediaEntry({ folderPath: pathValue }).id;
        });
        const unique = {};
        ids.forEach(function (id) {
            unique[id] = true;
        });
        expect(Object.keys(unique).length).toBe(paths.length);
    });

    test("two legacy entries that migrate to the same ID fail before publication", () => {
        const harness = makeRepository({});
        const baselineCommit = harness.repository.commitOptimisticBatch([
            { id: "media-existing", sourcePath: "C:/media/existing.mp4" },
        ]);
        expect(baselineCommit.ok).toBe(true);
        const baseline = harness.repository.snapshot();
        const persistedBefore = harness.persisted.length;

        // Both entries lack an ID and lack a source path, so nothing dedupes
        // them: their folder paths normalize to the same value and therefore to
        // the same derived ID.
        const result = harness.repository.commitOptimisticBatch([
            { folderPath: "C:/media/dup" },
            { folderPath: "C:\\media\\dup\\" },
        ]);

        expect(result.ok).toBe(false);
        expect(result.operation).toBe("commitOptimisticBatch");
        expect(result.error).toBeInstanceOf(Error);
        expect(String(result.error.message)).toMatch(/stable ID collision/i);
        // Nothing was published or persisted for the rejected batch.
        expect(harness.persisted.length).toBe(persistedBefore);
        expect(harness.repository.snapshot()).toEqual(baseline);
        expect(harness.mirror).toEqual(baseline);
    });
});

// ─── Conflicting top-level vs nested metadata (Req 5.4, 5.11) ─────────────────
describe("conflicting top-level and nested metadata fields (Req 5.4, 5.11)", () => {
    test("the top-level value wins, the legacy object is retained, and legacy-only fields are promoted", () => {
        const harness = makeRepository({});
        const entry = {
            id: "media-hybrid",
            sourcePath: "C:\\media\\new clip.mp4",
            category: "video",
            displayName: "New Clip",
            unknownTop: { kept: [1, 2, 3] },
            metadata: {
                sourcePath: "D:\\legacy\\old clip.mov",
                category: "legacy-video",
                displayName: "Legacy Clip",
                legacyOnly: "legacy-value",
                legacyUnknown: { nested: true },
            },
        };

        expect(harness.repository.commitOptimisticBatch([entry]).ok).toBe(true);
        const stored = harness.repository.getById("media-hybrid");

        // Top-level values are authoritative for every conflicting field.
        expect(stored.sourcePath).toBe("C:/media/new clip.mp4");
        expect(stored.category).toBe("video");
        expect(stored.displayName).toBe("New Clip");

        // The legacy object survives verbatim except for normalized paths.
        expect(stored.metadata).toEqual({
            sourcePath: "D:/legacy/old clip.mov",
            category: "legacy-video",
            displayName: "Legacy Clip",
            legacyOnly: "legacy-value",
            legacyUnknown: { nested: true },
        });

        // Legacy fields with no top-level counterpart are promoted top-level.
        expect(stored.legacyOnly).toBe("legacy-value");
        expect(stored.legacyUnknown).toEqual({ nested: true });
        // Unknown top-level fields are preserved unchanged.
        expect(stored.unknownTop).toEqual({ kept: [1, 2, 3] });

        // The entry is addressable by its top-level normalized source path.
        expect(harness.repository.getBySourcePath("C:\\media\\new clip.mp4\\").id).toBe("media-hybrid");
    });

    test("promotion never overwrites a falsy but present top-level value", () => {
        const harness = makeRepository({});
        expect(
            harness.repository.commitOptimisticBatch([
                {
                    id: "media-falsy",
                    sourcePath: "C:/media/falsy.mp4",
                    proxyPath: "",
                    hasProxy: false,
                    frameCount: 0,
                    metadata: { proxyPath: "D:/legacy/proxy.mp4", hasProxy: true, frameCount: 42 },
                },
            ]).ok
        ).toBe(true);

        const stored = harness.repository.getById("media-falsy");
        expect(stored.proxyPath).toBe("");
        expect(stored.hasProxy).toBe(false);
        expect(stored.frameCount).toBe(0);
        expect(stored.metadata.hasProxy).toBe(true);
        expect(stored.metadata.frameCount).toBe(42);
    });
});

// ─── Storage errors (Req 5.13) ────────────────────────────────────────────────
describe("storage failures preserve the last durable snapshot (Req 5.13)", () => {
    function committedBaseline() {
        const harness = makeRepository({ validityKey: "key-0" });
        const commit = harness.repository.commitOptimisticBatch([
            { id: "media-1", sourcePath: "C:/media/one.mp4", category: "video", thumbStatus: "pending" },
            { id: "media-2", sourcePath: "C:/media/two.png", category: "image", thumbStatus: "ready" },
        ]);
        expect(commit.ok).toBe(true);
        return harness;
    }

    test("a throwing storage sink returns a typed failure and changes nothing", () => {
        const harness = committedBaseline();
        const baseline = harness.repository.snapshot();
        const persistedPayload = harness.persisted[harness.persisted.length - 1];

        const error = new Error("localStorage quota exceeded");
        harness.state.persistError = error;
        const result = harness.repository.commitOptimisticBatch([
            { id: "media-3", sourcePath: "C:/media/three.mov" },
        ]);

        expect(result).toEqual({ ok: false, operation: "commitOptimisticBatch", error: error });
        expect(harness.repository.lastError().operation).toBe("commitOptimisticBatch");
        expect(harness.repository.snapshot()).toEqual(baseline);
        expect(harness.mirror).toEqual(baseline);
        expect(harness.repository.getById("media-3")).toBe(null);
        // No new durable payload was written.
        expect(harness.persisted[harness.persisted.length - 1]).toBe(persistedPayload);
    });

    test("a rejected asynchronous store leaves the patched entry untouched", async () => {
        const harness = committedBaseline();
        const baseline = harness.repository.snapshot();
        const persistedCount = harness.persisted.length;

        const error = new Error("async storage offline");
        harness.state.persistRejection = error;
        const result = await Promise.resolve(
            harness.repository.patchById("media-1", { thumbFile: "thumb-1.png", thumbStatus: "ready" })
        );

        expect(result).toEqual({ ok: false, operation: "patchById", error: error });
        expect(harness.repository.snapshot()).toEqual(baseline);
        expect(harness.repository.getById("media-1").thumbStatus).toBe("pending");
        expect(harness.repository.getById("media-1").thumbFile).toBeUndefined();
        expect(harness.persisted.length).toBe(persistedCount);

        // The repository is still usable once storage recovers.
        harness.state.persistRejection = null;
        const retry = await Promise.resolve(
            harness.repository.patchById("media-1", { thumbFile: "thumb-1.png", thumbStatus: "ready" })
        );
        expect(retry.ok).toBe(true);
        expect(harness.repository.getById("media-1").thumbStatus).toBe("ready");
        expect(harness.persisted.length).toBe(persistedCount + 1);
    });

    test("a patch for an unknown ID reports the failed operation without publishing", () => {
        const harness = committedBaseline();
        const baseline = harness.repository.snapshot();

        const result = harness.repository.patchById("media-missing", { thumbStatus: "ready" });
        expect(result.ok).toBe(false);
        expect(result.operation).toBe("patchById");
        expect(result.error).toBeInstanceOf(Error);
        expect(harness.repository.snapshot()).toEqual(baseline);
    });
});

// ─── Asynchronous validity refresh (Req 5.13, 7.5) ────────────────────────────
describe("refreshValidityAsync (Req 5.13, 7.5)", () => {
    function fakeFs(names) {
        const calls = { readdir: 0, stat: 0, sync: 0 };
        function forbidSync() {
            calls.sync++;
            throw new Error("synchronous filesystem API is not allowed here");
        }
        return {
            calls: calls,
            fs: {
                readdir: function (dir, cb) {
                    calls.readdir++;
                    setTimeout(function () {
                        cb(null, names.slice());
                    }, 0);
                },
                stat: function (target, cb) {
                    calls.stat++;
                    setTimeout(function () {
                        cb(null, { size: 10, mtimeMs: 5 });
                    }, 0);
                },
                readdirSync: forbidSync,
                statSync: forbidSync,
                existsSync: forbidSync,
                readFileSync: forbidSync,
            },
        };
    }

    test("updates only the persisted validity key, using async fs and no per-entry scan", async () => {
        const disk = fakeFs(["one.mp4"]);
        const harness = makeRepository({
            validityKey: "stale-key",
            validityPaths: ["C:\\media\\lib\\"],
            fs: disk.fs,
        });

        expect(
            harness.repository.commitOptimisticBatch([
                { id: "media-1", sourcePath: "C:/media/lib/one.mp4", category: "video" },
                { id: "media-2", sourcePath: "C:/media/lib/two.png", category: "image" },
                { id: "media-3", sourcePath: "C:/media/lib/three.mov", category: "video" },
            ]).ok
        ).toBe(true);

        const beforeEntries = harness.repository.snapshot();
        const beforeEnvelope = JSON.parse(harness.persisted[harness.persisted.length - 1]);
        expect(beforeEnvelope.validityKey).toBe("stale-key");

        const result = await harness.repository.refreshValidityAsync();

        expect(result.ok).toBe(true);
        expect(result.operation).toBe("refreshValidityAsync");
        // count(1 child) : totalSize(dir + child) : max mtime
        expect(result.validityKey).toBe("C:/media/lib:1:20:5");

        const afterEnvelope = JSON.parse(harness.persisted[harness.persisted.length - 1]);
        expect(afterEnvelope.validityKey).toBe("C:/media/lib:1:20:5");
        expect(afterEnvelope.entries).toEqual(beforeEntries);
        expect(harness.repository.snapshot()).toEqual(beforeEntries);
        expect(harness.mirror).toEqual(beforeEntries);

        // Only the declared validity path was enumerated: one readdir for three
        // entries proves no per-entry rescan happened, and no sync API was used.
        expect(disk.calls.readdir).toBe(1);
        expect(disk.calls.sync).toBe(0);
    });

    test("a failed validity refresh keeps the previous key and entries", async () => {
        const harness = makeRepository({
            validityKey: "good-key",
            validityPaths: ["C:/media/lib"],
            fs: fakeFs(["one.mp4"]).fs,
        });
        expect(
            harness.repository.commitOptimisticBatch([{ id: "media-1", sourcePath: "C:/media/lib/one.mp4" }]).ok
        ).toBe(true);
        const baseline = harness.repository.snapshot();

        const error = new Error("validity write failed");
        harness.state.persistError = error;
        const result = await harness.repository.refreshValidityAsync();

        expect(result).toEqual({ ok: false, operation: "refreshValidityAsync", error: error });
        expect(harness.repository.snapshot()).toEqual(baseline);
        expect(JSON.parse(harness.persisted[harness.persisted.length - 1]).validityKey).toBe("good-key");
    });
});

// ─── Warm-render field and path equality (Req 5.4, 5.5, 7.5) ──────────────────
describe("warm-render projection equals the end-of-import-session projection (Req 5.4, 5.5, 7.5)", () => {
    test("field names, values, and media paths survive a panel restart unchanged", () => {
        const sessionMirror = [];
        const session = makeRepository({ mirror: sessionMirror, validityKey: "session-key" });

        // A legacy record, a new-style record, and a hybrid record with unknown
        // fields — the mixture a real library carries at restart.
        expect(
            session.repository.commitOptimisticBatch([
                legacyEntry("C:\\media\\legacy clip.mov", { displayName: "Legacy", legacyFlag: 1 }),
                {
                    id: "media-new",
                    sourcePath: "C:\\media\\new clip.mp4",
                    folderPath: "C:\\media\\",
                    category: "video",
                    thumbFile: "thumb-new.png",
                    unknownField: { deep: ["a", 1, true, null] },
                },
                {
                    id: "media-hybrid",
                    sourcePath: "C:/media/hybrid.png",
                    category: "image",
                    metadata: { sourcePath: "D:\\legacy\\hybrid.png", legacyOnly: "kept" },
                },
            ]).ok
        ).toBe(true);

        // Simulate terminal background completion during the same session.
        expect(session.repository.patchById("media-new", { thumbStatus: "ready", terminalState: "completed" }).ok).toBe(
            true
        );

        const endOfSession = jsonClone(sessionMirror);
        const persistedPayload = session.persisted[session.persisted.length - 1];

        // ── Panel restart: parse the durable payload and project for render ───
        const envelope = JSON.parse(persistedPayload);
        const warmMirror = [];
        const warm = makeRepository({
            entries: envelope.entries,
            mirror: warmMirror,
            validityKey: envelope.validityKey,
        });
        expect(warm.repository.commitOptimisticBatch([]).ok).toBe(true);

        // Exactly one projected entry per retained entry, in the same order.
        expect(warmMirror.length).toBe(endOfSession.length);
        expect(warmMirror).toEqual(endOfSession);

        for (let i = 0; i < endOfSession.length; i++) {
            const expected = endOfSession[i];
            const rendered = warmMirror[i];

            // Field name sets are identical.
            expect(Object.keys(rendered).sort()).toEqual(Object.keys(expected).sort());
            // Stable identity and every field value are identical.
            expect(rendered.id).toBe(expected.id);
            Object.keys(expected).forEach(function (key) {
                expect(rendered[key]).toEqual(expected[key]);
            });
            // Media paths are already normalized and stay byte-identical.
            ["sourcePath", "folderPath", "thumbFile"].forEach(function (key) {
                if (Object.prototype.hasOwnProperty.call(expected, key) && typeof expected[key] === "string") {
                    expect(rendered[key]).toBe(expected[key]);
                    if (key !== "thumbFile") expect(rendered[key]).toBe(normalizeFolderPath(expected[key]));
                }
            });
            // Lookups agree across the restart boundary.
            expect(warm.repository.getById(expected.id)).toEqual(session.repository.getById(expected.id));
            if (typeof expected.sourcePath === "string") {
                expect(warm.repository.getBySourcePath(expected.sourcePath)).toEqual(
                    session.repository.getBySourcePath(expected.sourcePath)
                );
            }
        }

        // Re-persisting the warm index reproduces the same durable entries.
        expect(JSON.parse(warm.persisted[warm.persisted.length - 1]).entries).toEqual(envelope.entries);
    });
});
