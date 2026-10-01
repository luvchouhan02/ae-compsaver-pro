/**
 * Root_Manifest, versioned Combined_Validity_Key, Root_Signature — property suite
 * ==============================================================================
 *
 * Feature: panel-reopen-startup (Wave 2, master prompt item 3)
 *
 * What is under test
 * ------------------
 * The REAL incremental-invalidation half of `js/core/persistence.js`
 * (`loadRootManifest`, `getRootGeneration`, `bumpRootGeneration`,
 * `deriveRootSignature`, `deriveRootSignatureAsync`, `buildCombinedValidityKey`,
 * `parseCombinedValidityKey`, `resolveValidityPaths`,
 * `getCombinedDiskValidityKey`, `deriveCombinedValidityKeyAsync`,
 * `deriveFolderValidityKey`), loaded into a `vm` realm through the established
 * `loadHelpers` harness, plus the REAL changed-root diff
 * `changedRootsFromKeys` from `js/templates/templates.js`, loaded into its own
 * realm with the shipped `parseCombinedValidityKey` injected.
 *
 * No shipped logic is restated here. Every claim is made by calling the
 * shipped function and inspecting what it returned or what it touched.
 *
 * Only the environment is substituted at the boundary:
 *
 *   - `localStorage` — an in-memory stub, so `Root_Manifest` really is written
 *     and re-read through `commitVerifiedLocalStorage`.
 *   - `nfs()` / the injected `fsImpl` — an in-memory filesystem that RECORDS
 *     every `readdir` / `stat` / `readdirSync` / `statSync` call against the
 *     path it was made for. That recording is the evidence for "zero disk
 *     reads for the short-circuited root", and its `readFile` / `readFileSync`
 *     / `open` / `openSync` counters are the evidence for "opens no file".
 *
 * Filesystem model
 * ----------------
 * Directory metadata is explicit: every node carries its own `size` and
 * `mtimeMs`, and a mutation moves exactly the metadata the generator says it
 * moves. Depth-2 mutations are modelled WITHOUT propagating an mtime bump up to
 * the containing folder — the conservative filesystem the design's "too weak"
 * argument is about (network shares and filesystems that do not refresh a
 * directory's mtime for you). That is the model in which the staleness hole is
 * observable: the entry count of a section folder moves, so `deriveRootSignature`
 * moves, while `deriveFolderValidityKey` — which never looks below the root's
 * direct children — cannot see it.
 *
 * Scope note on Property 13
 * -------------------------
 * Requirement 8.8 scopes exact-path round-tripping to colons: "independent of
 * colons inside either the path or the token". `;` is the v2 segment delimiter
 * and is NOT escaped by the shipped format, so a root path containing `;` does
 * not round-trip. The property generator therefore covers drive-letter paths,
 * UNC paths, colon-bearing paths and prefix-overlapping paths, and the
 * semicolon case is pinned by a separate example test that documents the
 * observed limitation rather than asserting a guarantee the shipped format does
 * not make.
 */

"use strict";

const path = require("path");
const fc = require("fast-check");

const { loadHelpers } = require("../helpers/loadHelpers.js");

// The two realms below are built once and re-pointed per run (fast-check runs
// are sequential and awaited, so there is no interleaving). Re-parsing
// persistence.js 300 times would otherwise dominate the suite runtime; with the
// realms hoisted, all three properties finish well inside Jest's default
// timeout, so no file-level jest.setTimeout is needed here.

// ─── In-memory recording filesystem ─────────────────────────────────────────
/**
 * A synchronous AND asynchronous in-memory filesystem that records every call.
 *
 * `calls` is the instrumentation Property 12 reads: one entry per fs call, with
 * the operation name and the exact path it was made for, so "this root was
 * never touched" is a fact about recorded calls rather than an inference.
 *
 * `readFileSync` / `readFile` / `open` / `openSync` exist only so that a file
 * open would be RECORDED if it ever happened (Property 14 asserts the count is
 * zero). They are never expected to be reached.
 */
function createRecordingFilesystem() {
    const nodes = Object.create(null);
    const calls = [];

    function record(op, target) {
        calls.push({ op: op, path: String(target) });
    }
    function splitParent(p) {
        const text = String(p);
        const at = text.lastIndexOf("/");
        if (at <= 0) return { parent: "", name: text };
        return { parent: text.substring(0, at), name: text.substring(at + 1) };
    }
    function attach(p) {
        const sp = splitParent(p);
        const parent = nodes[sp.parent];
        if (parent && parent.dir && parent.children.indexOf(sp.name) === -1) {
            parent.children.push(sp.name);
        }
    }
    function detach(p) {
        const sp = splitParent(p);
        const parent = nodes[sp.parent];
        if (!parent || !parent.dir) return;
        const at = parent.children.indexOf(sp.name);
        if (at !== -1) parent.children.splice(at, 1);
    }
    function statOf(node) {
        return {
            size: node.size,
            mtimeMs: node.mtimeMs,
            isDirectory: function () { return node.dir === true; },
        };
    }
    function enoent(p) { return new Error("ENOENT: " + p); }
    function enotdir(p) { return new Error("ENOTDIR: " + p); }

    const api = {
        nodes: nodes,
        calls: calls,
        mkdir: function (p, mtimeMs) {
            nodes[p] = { dir: true, size: 0, mtimeMs: mtimeMs, children: [] };
            attach(p);
            return api;
        },
        addFile: function (p, size, mtimeMs) {
            nodes[p] = { dir: false, size: size, mtimeMs: mtimeMs, children: [] };
            attach(p);
            return api;
        },
        remove: function (p) {
            const node = nodes[p];
            if (!node) return api;
            if (node.dir) {
                const names = node.children.slice();
                for (let i = 0; i < names.length; i++) api.remove(p + "/" + names[i]);
            }
            detach(p);
            delete nodes[p];
            return api;
        },
        setSize: function (p, size) {
            if (nodes[p]) nodes[p].size = size;
            return api;
        },
        setMtime: function (p, mtimeMs) {
            if (nodes[p]) nodes[p].mtimeMs = mtimeMs;
            return api;
        },
        children: function (p) {
            return nodes[p] && nodes[p].dir ? nodes[p].children.slice() : [];
        },
        maxMtime: function () {
            let max = 0;
            const keys = Object.keys(nodes);
            for (let i = 0; i < keys.length; i++) {
                if (nodes[keys[i]].mtimeMs > max) max = nodes[keys[i]].mtimeMs;
            }
            return max;
        },
        resetCalls: function () {
            calls.length = 0;
            return api;
        },
        /** Every recorded call made for `root` itself or anything beneath it. */
        callsUnder: function (root) {
            const prefix = String(root) + "/";
            return calls.filter(function (c) {
                return c.path === String(root) || c.path.indexOf(prefix) === 0;
            });
        },
        /** Recorded calls of one operation against one exact path. */
        callsOf: function (op, target) {
            return calls.filter(function (c) { return c.op === op && c.path === String(target); });
        },
        /** File-content access of any kind. Must always be zero. */
        fileOpens: function () {
            return calls.filter(function (c) { return c.op === "open"; }).length;
        },
        fs: {
            readdirSync: function (p) {
                record("readdirSync", p);
                const node = nodes[p];
                if (!node) throw enoent(p);
                if (!node.dir) throw enotdir(p);
                return node.children.slice();
            },
            statSync: function (p) {
                record("statSync", p);
                const node = nodes[p];
                if (!node) throw enoent(p);
                return statOf(node);
            },
            readdir: function (p, callback) {
                record("readdir", p);
                const node = nodes[p];
                if (!node) { callback(enoent(p)); return; }
                if (!node.dir) { callback(enotdir(p)); return; }
                callback(null, node.children.slice());
            },
            stat: function (p, callback) {
                record("stat", p);
                const node = nodes[p];
                if (!node) { callback(enoent(p)); return; }
                callback(null, statOf(node));
            },
            // Recorded, never expected. A signature that opened a file would be
            // caught by the `open` counter instead of silently passing.
            readFileSync: function (p) { record("open", p); return ""; },
            readFile: function (p, encodingOrCb, maybeCb) {
                record("open", p);
                const cb = typeof encodingOrCb === "function" ? encodingOrCb : maybeCb;
                if (typeof cb === "function") cb(null, "");
            },
            openSync: function (p) { record("open", p); return 7; },
            open: function (p, flagsOrCb, maybeCb) {
                record("open", p);
                const cb = typeof flagsOrCb === "function" ? flagsOrCb : maybeCb;
                if (typeof cb === "function") cb(null, 7);
            },
        },
    };
    return api;
}

// ─── localStorage stub ──────────────────────────────────────────────────────
function createStorage() {
    const data = Object.create(null);
    return {
        data: data,
        getItem: function (key) {
            return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
        },
        setItem: function (key, value) { data[key] = String(value); },
        removeItem: function (key) { delete data[key]; },
    };
}

// ─── The realms ─────────────────────────────────────────────────────────────
// `realmState` is what each run re-points: the persistence realm sees a fresh
// localStorage and a fresh filesystem without being rebuilt.
const realmState = { storage: createStorage(), disk: createRecordingFilesystem() };

const quietConsole = {
    log: function () { },
    warn: function () { },
    error: function () { },
};

const persistenceSandbox = loadHelpers({
    file: path.join("js", "core", "persistence.js"),
    lenient: false,
    injected: {
        console: quietConsole,
        localStorage: {
            getItem: function (key) { return realmState.storage.getItem(key); },
            setItem: function (key, value) { realmState.storage.setItem(key, value); },
            removeItem: function (key) { realmState.storage.removeItem(key); },
        },
        // The default fs the zero-argument shipped call sites resolve through.
        nfs: function () { return realmState.disk.fs; },
    },
});

const P = {
    normalizeFolderPath: persistenceSandbox.get("normalizeFolderPath"),
    loadRootManifest: persistenceSandbox.get("loadRootManifest"),
    getRootGeneration: persistenceSandbox.get("getRootGeneration"),
    bumpRootGeneration: persistenceSandbox.get("bumpRootGeneration"),
    deriveRootSignature: persistenceSandbox.get("deriveRootSignature"),
    deriveRootSignatureAsync: persistenceSandbox.get("deriveRootSignatureAsync"),
    buildCombinedValidityKey: persistenceSandbox.get("buildCombinedValidityKey"),
    parseCombinedValidityKey: persistenceSandbox.get("parseCombinedValidityKey"),
    resolveValidityPaths: persistenceSandbox.get("resolveValidityPaths"),
    getCombinedDiskValidityKey: persistenceSandbox.get("getCombinedDiskValidityKey"),
    deriveCombinedValidityKeyAsync: persistenceSandbox.get("deriveCombinedValidityKeyAsync"),
    deriveFolderValidityKey: persistenceSandbox.get("deriveFolderValidityKey"),
    LibraryIndex: persistenceSandbox.get("LibraryIndex"),
    ROOT_MANIFEST_KEY: persistenceSandbox.context.ROOT_MANIFEST_KEY,
    VALIDITY_KEY_PREFIX: persistenceSandbox.context.VALIDITY_KEY_PREFIX,
    VALIDITY_FIELD_SEP: persistenceSandbox.context.VALIDITY_FIELD_SEP,
};

// The changed-root diff lives in templates.js and is loaded here with the
// shipped parser injected, exactly as the panel has it — persistence.js and
// templates.js side by side in one script scope.
const templatesSandbox = loadHelpers({
    file: path.join("js", "templates", "templates.js"),
    lenient: false,
    injected: {
        console: quietConsole,
        parseCombinedValidityKey: P.parseCombinedValidityKey,
    },
});
const changedRootsFromKeys = templatesSandbox.get("changedRootsFromKeys");

/** Point both realms at a fresh world. Returns the world. */
function freshWorld() {
    realmState.storage = createStorage();
    realmState.disk = createRecordingFilesystem();
    return { storage: realmState.storage, disk: realmState.disk };
}

function sorted(list) {
    return list.slice().sort();
}

// ════════════════════════════════════════════════════════════════════════════
// Task 9.3 — Property 12
// ════════════════════════════════════════════════════════════════════════════

// Non-overlapping library roots: none is a path prefix of another, so "every
// recorded call beneath this root" attributes unambiguously to one root. Path
// prefix overlap is Property 13's subject, where no disk is involved at all.
const ROOT_POOL = [
    "C:/lib/alpha",
    "C:/lib/beta",
    "D:/shared/gamma",
    "//server/share/delta",
    "E:/epsilon",
];

/** One library root on disk: a manifest file plus `folderCount` section folders. */
function buildRootTree(disk, root, folderCount) {
    disk.mkdir(root, 1000);
    disk.addFile(root + "/manifest.json", 128, 1100);
    for (let f = 0; f < folderCount; f++) {
        const folder = root + "/section" + f;
        disk.mkdir(folder, 1200 + f);
        disk.addFile(folder + "/item" + f + ".aep", 2048 + f, 1300 + f);
    }
}

const generationScenario = fc
    .uniqueArray(fc.constantFrom.apply(fc, ROOT_POOL), { minLength: 1, maxLength: 4 })
    .chain(function (roots) {
        return fc.record({
            roots: fc.constant(roots),
            // A sequence of Owned_Mutation bumps by root index. Repeats matter:
            // the same root bumped twice is still exactly one changed root.
            bumps: fc.array(fc.nat({ max: roots.length - 1 }), { maxLength: 8 }),
            // Per-root disk shape (number of section folders).
            folders: fc.array(fc.integer({ min: 1, max: 3 }), {
                minLength: roots.length,
                maxLength: roots.length,
            }),
        });
    });

describe("Root_Manifest generations drive invalidation without disk reads", () => {
    // Feature: panel-reopen-startup, Property 12: Owned mutations are detected without touching disk
    //
    // **Validates: Requirements 8.1, 8.3, 8.4, 11.1**
    //
    // For any root set and any sequence of `bumpRootGeneration` calls, the
    // changed-root set derived by comparing the stored and current
    // `Combined_Validity_Key` equals exactly the set of bumped roots, and every
    // bumped root is decided with ZERO filesystem calls — its segment is emitted
    // from the generation alone. `Root_Signature` derivation happens for, and
    // only for, the roots the generation could not decide, which is what keeps
    // an External_Mutation detectable (Requirements 8.6, 8.7).
    it("Property 12: Owned mutations are detected without touching disk", async () => {
        await fc.assert(
            fc.asyncProperty(generationScenario, async (scenario) => {
                const world = freshWorld();
                const disk = world.disk;
                const roots = scenario.roots;
                const normRoots = roots.map(P.normalizeFolderPath);

                for (let i = 0; i < roots.length; i++) {
                    buildRootTree(disk, normRoots[i], scenario.folders[i]);
                }

                // The key as it was persisted by the previous session, through
                // the shipped synchronous startup path.
                const storedKey = P.getCombinedDiskValidityKey(roots);
                const storedParsed = P.parseCombinedValidityKey(storedKey);
                expect(storedParsed.version).toBe(2);

                // Owned mutations: CompSaver's own writes, recorded as generations.
                const bumped = {};
                for (let b = 0; b < scenario.bumps.length; b++) {
                    const root = normRoots[scenario.bumps[b]];
                    P.bumpRootGeneration(root);
                    bumped[root] = true;
                }
                const bumpedRoots = normRoots.filter(function (r) { return bumped[r] === true; });
                const unbumpedRoots = normRoots.filter(function (r) { return bumped[r] !== true; });

                // Everything from here on is what the background validity pass costs.
                disk.resetCalls();
                const newKey = await P.deriveCombinedValidityKeyAsync(roots, disk.fs, storedKey);
                const newParsed = P.parseCombinedValidityKey(newKey);
                const changed = changedRootsFromKeys(storedKey, newKey);

                // The current key names exactly the scanned roots, by exact path.
                expect(newParsed.version).toBe(2);
                expect(sorted(Object.keys(newParsed.tokens))).toEqual(sorted(normRoots));

                // The changed-root set is exactly the bumped set.
                expect(sorted(changed)).toEqual(sorted(bumpedRoots));

                // Every bumped root was decided without a single filesystem call,
                // and its token records that the generation decided it.
                for (let i = 0; i < bumpedRoots.length; i++) {
                    const root = bumpedRoots[i];
                    expect(disk.callsUnder(root)).toEqual([]);
                    expect(newParsed.tokens[root]).toBe(P.getRootGeneration(root) + "~gen");
                }

                // Every unbumped root kept its stored token — a cache hit — and it
                // is the only kind of root a signature was derived for.
                const derived = normRoots.filter(function (root) {
                    return disk.callsOf("readdir", root).length > 0;
                });
                expect(sorted(derived)).toEqual(sorted(unbumpedRoots));
                for (let i = 0; i < unbumpedRoots.length; i++) {
                    const root = unbumpedRoots[i];
                    expect(newParsed.tokens[root]).toBe(storedParsed.tokens[root]);
                }

                // Directory metadata only: no file was ever opened.
                expect(disk.fileOpens()).toBe(0);
            }),
            { numRuns: 15 }
        );
    });

    it("a bump survives a reload of Root_Manifest and reads as a non-negative integer", () => {
        const world = freshWorld();
        expect(P.getRootGeneration("C:/lib/alpha")).toBe(0);
        expect(P.bumpRootGeneration("C:/lib/alpha")).toBe(1);
        expect(P.bumpRootGeneration("C:/lib/alpha")).toBe(2);
        expect(P.getRootGeneration("C:/lib/alpha")).toBe(2);
        expect(P.getRootGeneration("C:/lib/beta")).toBe(0);
        // Written under the documented key, in the documented shape.
        const raw = world.storage.getItem(P.ROOT_MANIFEST_KEY);
        expect(JSON.parse(raw)).toEqual({ version: 1, roots: { "C:/lib/alpha": 2 } });
    });

    it("an unparseable Root_Manifest reads as generation 0 for every root", () => {
        const world = freshWorld();
        world.storage.setItem(P.ROOT_MANIFEST_KEY, "{not json");
        expect(P.getRootGeneration("C:/lib/alpha")).toBe(0);
        expect(P.loadRootManifest().roots).toEqual({});
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Task 9.4 — Property 13
// ════════════════════════════════════════════════════════════════════════════

// Path segment alphabet: letters, digits, spaces, dots and underscores — every
// character a Windows folder name may legally hold that is not one of the two v2
// delimiters (";" and U+001F). See the scope note at the head of this file.
const SEGMENT_CHARS = ["a", "b", "c", "x", "Z", "1", "2", "_", " ", ".", "-", "~"];

const segmentArb = fc
    .array(fc.constantFrom.apply(fc, SEGMENT_CHARS), { minLength: 1, maxLength: 6 })
    .map(function (chars) { return chars.join(""); })
    .filter(function (name) {
        return name.replace(/\s+/g, "") !== "" && name !== "." && name !== "..";
    });

// Every path shape the requirement names, so the exact-path claim is made over
// drive letters, UNC roots, and colons inside the path itself.
const PATH_SHAPES = [
    function (name) { return "C:/" + name; },
    function (name) { return "C:/lib/" + name; },
    function (name) { return "//server/share/" + name; },
    function (name) { return "//srv/s/" + name + ":stream"; },
    function (name) { return "D:/a:b/" + name; },
    function (name) { return "Z:/" + name + "/nested/deep"; },
];

const pathArb = fc
    .tuple(fc.nat({ max: PATH_SHAPES.length - 1 }), segmentArb)
    .map(function (pair) { return PATH_SHAPES[pair[0]](pair[1]); });

// Always includes the prefix-overlapping pair ("C:/lib" and "C:/lib/a"), a UNC
// root, and a colon-bearing root, so the shrunk counterexample of any failure
// still carries the hard cases.
const pathSetArb = fc
    .uniqueArray(pathArb, { minLength: 1, maxLength: 5 })
    .map(function (generated) {
        const fixed = ["C:/lib", "C:/lib/a", "//server/share/lib", "D:/weird:name/x"];
        const seen = Object.create(null);
        const out = [];
        const all = fixed.concat(generated);
        for (let i = 0; i < all.length; i++) {
            if (seen[all[i]]) continue;
            seen[all[i]] = true;
            out.push(all[i]);
        }
        return out;
    });

// A Root_Signature as the shipped derivation emits it: digits, ":" and "|",
// or one of the two sentinels.
const tripleArb = fc
    .tuple(fc.nat({ max: 99 }), fc.nat({ max: 999999 }), fc.integer({ min: 0, max: 4000000000000 }))
    .map(function (t) { return t[0] + ":" + t[1] + ":" + t[2]; });

const sigArb = fc.oneof(
    fc.constant("null"),
    fc.constant("gen"),
    tripleArb,
    fc.tuple(tripleArb, fc.array(tripleArb, { maxLength: 4 })).map(function (t) {
        return [t[0]].concat(t[1]).join("|");
    })
);

const segmentsArb = pathSetArb.chain(function (paths) {
    return fc.record({
        paths: fc.constant(paths),
        gens: fc.array(fc.nat({ max: 500 }), { minLength: paths.length, maxLength: paths.length }),
        sigs: fc.array(sigArb, { minLength: paths.length, maxLength: paths.length }),
    });
});

/** The pre-Wave-2 key shape: `<path>:<count>:<size>:<mtime>` joined by ";". */
function legacyValidityKey(paths) {
    const parts = [];
    for (let i = 0; i < paths.length; i++) {
        parts.push(paths[i] + ":" + (i + 1) + ":" + (100 * (i + 1)) + ":" + (1000 * (i + 1)));
    }
    return parts.join(";");
}

/** A persisted index with one entry per root, round-tripped through the real codec. */
function persistIndexForPaths(paths, validityKey) {
    const source = new P.LibraryIndex({ validityKey: validityKey });
    for (let i = 0; i < paths.length; i++) {
        source.insertAtHead({
            id: "tpl-" + i,
            name: "entry-" + i,
            category: "All",
            folderPath: paths[i] + "/comp/e" + i,
            sourcePath: paths[i],
        });
    }
    const parsed = P.LibraryIndex.tryParse(source.serialize());
    expect(parsed.ok).toBe(true);
    return parsed.index;
}

describe("The versioned Combined_Validity_Key round-trips by exact path", () => {
    // Feature: panel-reopen-startup, Property 13: The validity key round-trips by exact path
    //
    // **Validates: Requirements 8.8, 8.9**
    //
    // `parseCombinedValidityKey(buildCombinedValidityKey(segments))` recovers a
    // token map whose keys are the input paths byte for byte — drive letters, UNC
    // roots, colons inside the path, colons inside the token, and paths that are
    // prefixes of one another — and whose tokens are the input `gen~sig` pairs.
    // An identical key reports no changed root, which is what makes the exact-path
    // recovery load-bearing rather than incidental. Any non-v2 stored key (legacy,
    // `null`, `""`, garbage) reports every root in the current key as changed and
    // discards no persisted entry.
    it("Property 13: The validity key round-trips by exact path", () => {
        fc.assert(
            fc.property(segmentsArb, (scenario) => {
                const paths = scenario.paths;
                const segments = paths.map(function (p, i) {
                    return { path: p, gen: scenario.gens[i], sig: scenario.sigs[i] };
                });

                const key = P.buildCombinedValidityKey(segments);
                expect(key.substring(0, P.VALIDITY_KEY_PREFIX.length)).toBe(P.VALIDITY_KEY_PREFIX);

                const parsed = P.parseCombinedValidityKey(key);
                expect(parsed.version).toBe(2);

                // Keys are the input paths EXACTLY: no truncation at a colon, no
                // collapsing of a path onto the root it is a prefix of.
                expect(sorted(Object.keys(parsed.tokens))).toEqual(sorted(paths));
                for (let i = 0; i < segments.length; i++) {
                    expect(parsed.tokens[segments[i].path]).toBe(segments[i].gen + "~" + segments[i].sig);
                }

                // A key compared against itself changes nothing.
                expect(changedRootsFromKeys(key, key)).toEqual([]);

                // Any non-v2 stored key: every root changed, nothing discarded.
                const legacy = legacyValidityKey(paths);
                const nonV2 = [legacy, null, "", "not-a-key", P.VALIDITY_KEY_PREFIX.replace("2", "9")];
                for (let s = 0; s < nonV2.length; s++) {
                    const stored = nonV2[s];
                    expect(sorted(changedRootsFromKeys(stored, key))).toEqual(sorted(paths));

                    const li = persistIndexForPaths(paths, stored);
                    const before = li._entries.map(function (e) { return e.folderPath; });
                    changedRootsFromKeys(li.validityKey, key);
                    const after = li._entries.map(function (e) { return e.folderPath; });
                    expect(after).toEqual(before);
                    expect(after.length).toBe(paths.length);
                }
            }),
            { numRuns: 15 }
        );
    });

    it("a v2 key isolates the one root whose token moved, prefix overlap included", () => {
        const before = P.buildCombinedValidityKey([
            { path: "C:/lib", gen: 0, sig: "3:10:900" },
            { path: "C:/lib/a", gen: 0, sig: "1:20:900" },
            { path: "//server/share/lib", gen: 0, sig: "2:30:900" },
        ]);
        const after = P.buildCombinedValidityKey([
            { path: "C:/lib", gen: 0, sig: "3:10:900" },
            { path: "C:/lib/a", gen: 1, sig: "gen" },
            { path: "//server/share/lib", gen: 0, sig: "2:30:900" },
        ]);
        expect(changedRootsFromKeys(before, after)).toEqual(["C:/lib/a"]);
    });

    it("a root path containing the v2 segment delimiter is a known format limitation", () => {
        // Requirement 8.8 scopes exact-path recovery to colons. ";" is the
        // segment delimiter and is not escaped, so a ";" in a root path does not
        // round-trip. Pinned here so the boundary is visible instead of latent.
        const key = P.buildCombinedValidityKey([{ path: "C:/li;b", gen: 1, sig: "1:2:3" }]);
        const parsed = P.parseCombinedValidityKey(key);
        expect(Object.prototype.hasOwnProperty.call(parsed.tokens, "C:/li;b")).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Task 9.5 — Property 14
// ════════════════════════════════════════════════════════════════════════════

const FROZEN_FOLDER_KEY = /^\d+:\d+:\d+$/;

const fileSpecArb = fc.record({
    name: segmentArb,
    size: fc.nat({ max: 100000 }),
    mtime: fc.integer({ min: 1000, max: 5000000 }),
});

// The seven section folders the signature covers, in the order it folds them.
const SECTION_FOLDERS = ["comp", "effect", "footage", "icon", "layer", "overlay", "text"];

// Everything CompSaver itself writes into a library root. None of it is evidence
// that a template changed, and folding any of it into the signature is what made
// the key invalidate itself: every preview render moved `text_animations`, and
// every metadata save created and removed `.compsaver_metadata.json.tmp`, which
// moved the root's own directory mtime.
const ROOT_NOISE = [
    "text_animations", "preview_assets", "_shared", "effects",
    "preview_debug.txt", "migration.log",
    ".compsaver_metadata.json", ".compsaver_metadata.json.tmp",
];

const treeArb = fc.record({
    root: fc.constantFrom("C:/lib", "//server/share/lib", "D:/a:b/lib"),
    // A subset of the real section folders, each holding categories of templates.
    sections: fc.uniqueArray(
        fc.record({
            name: fc.constantFrom.apply(fc, SECTION_FOLDERS),
            categories: fc.uniqueArray(
                fc.record({
                    name: segmentArb,
                    mtime: fc.integer({ min: 1000, max: 5000000 }),
                    templates: fc.uniqueArray(fileSpecArb, {
                        maxLength: 3,
                        selector: function (spec) { return spec.name; },
                    }),
                }),
                { minLength: 1, maxLength: 3, selector: function (spec) { return spec.name; } }
            ),
        }),
        { minLength: 1, maxLength: 4, selector: function (spec) { return spec.name; } }
    ),
    // Noise that must never move the signature.
    noise: fc.uniqueArray(fc.constantFrom.apply(fc, ROOT_NOISE), { minLength: 1, maxLength: 4 }),
    mutation: fc.oneof(
        // A real template change: added or removed inside an existing category,
        // which moves that category's directory mtime.
        fc.record({
            target: fc.constant("template"),
            kind: fc.constantFrom("add", "remove"),
            index: fc.nat({ max: 9 }),
        }),
        // A real category change inside a section folder.
        fc.record({
            target: fc.constant("category"),
            kind: fc.constantFrom("add", "remove"),
            index: fc.nat({ max: 9 }),
        }),
        // CompSaver's own bookkeeping, in every shape it really takes.
        fc.record({
            target: fc.constant("noise"),
            kind: fc.constantFrom("add", "remove", "grow", "touch", "temp-cycle"),
            index: fc.nat({ max: 9 }),
        })
    ),
});

/**
 * Materialize the generated library: section folders holding categories holding
 * templates, plus the bookkeeping CompSaver drops in the root. Returns the paths
 * the mutation can target.
 */
function buildTree(disk, tree) {
    const root = tree.root;
    disk.mkdir(root, 1000);

    const sectionPaths = [];
    const categoryPaths = [];
    for (let s = 0; s < tree.sections.length; s++) {
        const section = tree.sections[s];
        const sectionPath = root + "/" + section.name;
        disk.mkdir(sectionPath, 1000);
        sectionPaths.push(sectionPath);
        for (let c = 0; c < section.categories.length; c++) {
            const category = section.categories[c];
            const categoryPath = sectionPath + "/cat" + category.name;
            disk.mkdir(categoryPath, category.mtime);
            categoryPaths.push(categoryPath);
            for (let t = 0; t < category.templates.length; t++) {
                const template = category.templates[t];
                disk.addFile(categoryPath + "/t" + template.name, template.size, template.mtime);
            }
        }
    }

    const noisePaths = [];
    for (let n = 0; n < tree.noise.length; n++) {
        const name = tree.noise[n];
        const full = root + "/" + name;
        // Directories for the render-output folders, files for the logs and the
        // metadata cache — the same shapes a real library root holds.
        if (name.indexOf(".") === -1) disk.mkdir(full, 1000 + n);
        else disk.addFile(full, 1024 + n, 1000 + n);
        noisePaths.push(full);
    }

    return {
        root: root,
        sectionPaths: sectionPaths,
        categoryPaths: categoryPaths,
        noisePaths: noisePaths,
    };
}

/**
 * Apply the generated mutation. Returns true when it is a real template-bearing
 * change the signature MUST see, false when it is CompSaver's own bookkeeping,
 * which the signature MUST ignore.
 */
function applyMutation(disk, layout, mutation) {
    const root = layout.root;

    if (mutation.target === "template") {
        const category = layout.categoryPaths[mutation.index % layout.categoryPaths.length];
        const kids = disk.children(category);
        if (mutation.kind === "remove" && kids.length > 0) {
            disk.remove(category + "/" + kids[mutation.index % kids.length]);
        } else {
            disk.addFile(category + "/added-template.aep", 2048, 2222);
        }
        // Adding or removing an entry moves the containing directory's mtime,
        // which is the evidence the signature folds.
        disk.setMtime(category, disk.maxMtime() + 1);
        return true;
    }

    if (mutation.target === "category") {
        const section = layout.sectionPaths[mutation.index % layout.sectionPaths.length];
        const kids = disk.children(section);
        if (mutation.kind === "remove" && kids.length > 0) {
            disk.remove(section + "/" + kids[mutation.index % kids.length]);
        } else {
            disk.mkdir(section + "/added-category", disk.maxMtime() + 1);
        }
        return true;
    }

    // CompSaver's own output, in every shape it really takes.
    const target = layout.noisePaths[mutation.index % layout.noisePaths.length];
    if (mutation.kind === "add") {
        disk.addFile(root + "/preview_debug.txt.1", 4096, disk.maxMtime() + 1);
    } else if (mutation.kind === "remove") {
        disk.remove(target);
    } else if (mutation.kind === "grow") {
        const node = disk.nodes[target];
        if (node && !node.isDir) disk.setSize(target, node.size + 4096);
    } else if (mutation.kind === "touch") {
        disk.setMtime(target, disk.maxMtime() + 1);
    } else {
        // The metadata cache's temp-file cycle: create then rename away. Both
        // steps change the root's directory entries, and therefore its own mtime.
        const tmp = root + "/.compsaver_metadata.json.tmp";
        disk.addFile(tmp, 3107, disk.maxMtime() + 1);
        disk.remove(tmp);
    }
    disk.setMtime(root, disk.maxMtime() + 1);
    return false;
}

/**
 * True when `target` sits at or above the category level — the root, a section
 * folder, or a category. The signature never descends below a category.
 */
function withinCategoryDepth(root, target) {
    if (target === root) return true;
    if (target.indexOf(root + "/") !== 0) return false;
    return target.substring(root.length + 1).split("/").length <= 2;
}

describe("Root_Signature sees nested change while the metadata key stays frozen", () => {
    // Feature: panel-reopen-startup, Property 14: Nested external changes move the signature, and the metadata key format is frozen
    //
    // **Validates: Requirements 8.5, 8.6, 8.11**
    //
    // For any synthetic library under a root, a real template-bearing change —
    // a template added or removed inside a category, or a category added or
    // removed inside a section folder — moves `deriveRootSignature`, while ANY
    // amount of CompSaver's own bookkeeping in the root leaves it byte-identical.
    //
    // That second half is the claim this property gained, and it is the bug it now
    // guards. The signature used to fold every direct entry of the root plus the
    // root's own directory mtime, so `text_animations` moving on each preview
    // render, `preview_debug.txt` growing, and the metadata cache's
    // create-then-rename temp sibling all moved the key on their own. The recorded
    // key never matched the derived one, every reopen reported "stale", and each
    // one paid a ~74 s blocking host rescan for a library that never changed —
    // a rescan that itself triggered more preview renders, guaranteeing the next
    // reopen was stale too.
    //
    // Sync and async agree on every tree, since the two are compared against each
    // other and any divergence would report a permanent false "stale".
    // `deriveFolderValidityKey` keeps its pre-Wave-2 `<count>:<totalSize>:<maxMtime>`
    // shape for every input — it is the persisted MetadataCache entry key. Neither
    // function descends below a category and neither ever opens a file.
    it("Property 14: Nested external changes move the signature, and the metadata key format is frozen", async () => {
        await fc.assert(
            fc.asyncProperty(treeArb, async (tree) => {
                const world = freshWorld();
                const disk = world.disk;
                const layout = buildTree(disk, tree);
                const root = layout.root;

                // ── before ──────────────────────────────────────────────────
                disk.resetCalls();
                const sigBefore = P.deriveRootSignature(root, disk.fs);
                const touchedPaths = disk.calls.map(function (c) { return c.path; });
                const sigBeforeAsync = await P.deriveRootSignatureAsync(root, disk.fs);

                expect(typeof sigBefore).toBe("string");
                expect(sigBeforeAsync).toBe(sigBefore);

                // Never below a category, and one fold per section folder.
                for (let i = 0; i < touchedPaths.length; i++) {
                    expect(withinCategoryDepth(root, touchedPaths[i])).toBe(true);
                }
                expect(sigBefore.split("|").length).toBe(SECTION_FOLDERS.length);

                // The frozen MetadataCache entry key, for every input.
                const folderKeyBefore = P.deriveFolderValidityKey(root, disk.fs);
                expect(folderKeyBefore).toMatch(FROZEN_FOLDER_KEY);
                expect(folderKeyBefore.split(":")[0]).toBe(String(disk.children(root).length));
                for (let f = 0; f < layout.categoryPaths.length; f++) {
                    const folderKey = P.deriveFolderValidityKey(layout.categoryPaths[f], disk.fs);
                    expect(folderKey).toMatch(FROZEN_FOLDER_KEY);
                    expect(folderKey.split(":")[0])
                        .toBe(String(disk.children(layout.categoryPaths[f]).length));
                }
                // An absent input yields null, never a malformed key.
                expect(P.deriveFolderValidityKey(root + "/absent-folder", disk.fs)).toBe(null);

                // ── mutate ──────────────────────────────────────────────────
                const isRealChange = applyMutation(disk, layout, tree.mutation);

                // ── after ───────────────────────────────────────────────────
                const sigAfter = P.deriveRootSignature(root, disk.fs);
                const sigAfterAsync = await P.deriveRootSignatureAsync(root, disk.fs);
                expect(sigAfterAsync).toBe(sigAfter);

                if (isRealChange) {
                    // Req 8.6: an external edit to template-bearing structure is seen.
                    expect(sigAfter).not.toBe(sigBefore);
                } else {
                    // The immunity claim: CompSaver's own output cannot invalidate
                    // its own cache, no matter which artifact moved or how.
                    expect(sigAfter).toBe(sigBefore);
                }

                const folderKeyAfter = P.deriveFolderValidityKey(root, disk.fs);
                expect(folderKeyAfter).toMatch(FROZEN_FOLDER_KEY);

                // Directory metadata only: no file was ever opened, by either
                // function, on either path.
                expect(disk.fileOpens()).toBe(0);
            }),
            { numRuns: 100 }
        );
    }, 120000);

    it("an unreadable root has no derivable signature", async () => {
        const world = freshWorld();
        expect(P.deriveRootSignature("C:/missing", world.disk.fs)).toBe(null);
        await expect(P.deriveRootSignatureAsync("C:/missing", world.disk.fs)).resolves.toBe(null);
    });
});
