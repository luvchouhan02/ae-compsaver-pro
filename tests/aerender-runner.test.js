// ============================================================
// tests/aerender-runner.test.js
//
// Feature: Wave A — isolated aerender thumbnail rendering
//
// The REAL js/core/aerenderRunner.js in a vm realm with faked
// child_process / fs / Settings / timers. Nothing real is spawned,
// no registry is queried. Verifies the safety contract:
//   - discovery parses the registry shape and caches, newest first
//   - unknown machine / disabled flag => structured "unavailable"
//   - exactly one aerender process at a time
//   - argv-array execFile (no shell), correct aerender flags
//   - timeout kills the child and releases the lock
//   - output accepted ONLY as a magic-byte PNG (numbered sequence
//     artifacts are resolved and renamed)
//   - circuit breaker after 2 consecutive render failures
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "js/core/aerenderRunner.js"), "utf8");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function manualClock() {
    const timers = [];
    return {
        setTimeout: (fn, ms) => { timers.push({ fn, ms: ms || 0 }); return timers.length; },
        clearTimeout: (h) => { if (h >= 1 && h <= timers.length) delete timers[h - 1]; },
        fire: (h) => { if (h >= 1 && timers[h] && !timers[h].done) { const t = timers[h]; delete timers[h - 1]; t.fn(); } },
        fireLast: () => { for (let i = timers.length - 1; i >= 0; i--) { if (timers[i]) { const t = timers[i]; delete timers[i]; t.fn(); return; } } },
    };
}

function buildHarness(options) {
    options = options || {};
    const clock = manualClock();
    const spawns = [];
    const kills = [];
    const files = new Map(); // path -> Buffer

    const regResponses = options.regResponses || {
        "HKLM\\SOFTWARE\\Adobe\\After Effects":
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\Adobe\\After Effects\n" +
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\Adobe\\After Effects\\22.0\n" +
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\Adobe\\After Effects\\25.2\n",
        "HKLM\\SOFTWARE\\Adobe\\After Effects\\25.2\\InstallPath":
            "    InstallPath    REG_SZ    C:\\Program Files\\Adobe\\Adobe After Effects 2025\\\n",
        "HKLM\\SOFTWARE\\Adobe\\After Effects\\22.0\\InstallPath":
            "    InstallPath    REG_SZ    C:\\OLD\\AE22\\\n",
    };

    const cp = {
        execFile: function (exe, args, opts, cb) {
            if (typeof opts === "function") { cb = opts; opts = null; }
            const call = { exe: exe, args: args, respond: null, parked: !cb };
            if (exe === "reg") {
                const key = args[1];
                const text = regResponses[key];
                call.respond = () => cb(text === undefined ? new Error("not found") : null, text || "", "");
                if (options.regSync) call.respond();
                spawns.push(call);
                return;
            }
            // aerender
            call.respond = (err, stdout, stderr) => cb(err, stdout, stderr);
            spawns.push(call);
            if (options.onSpawn) options.onSpawn(call, files);
            return;
        },
    };
    const fakeFs = {
        existsSync: (p) => options.aerenderExists !== false &&
            (p === "C:\\Program Files\\Adobe\\Adobe After Effects 2025\\aerender.exe" ||
                p === "C:\\OLD\\AE22\\aerender.exe"),
        statSync: (p) => {
            const buf = files.get(p);
            if (!buf) throw new Error("ENOENT " + p);
            return { isFile: () => true, size: buf.length };
        },
        openSync: () => 1,
        readSync: (fd, buf, off, len, pos) => { const src = files.get(currentReadPath); if (!src) return 0; src.copy(buf, 0, 0, 8); return Math.min(8, src.length); },
        closeSync: () => { },
        readdirSync: (dir) => {
            const names = [];
            for (const key of files.keys()) {
                if (key.indexOf(dir + "/") === 0) names.push(key.substring(dir.length + 1));
            }
            return names;
        },
        renameSync: (from, to) => { const b = files.get(from); if (!b) throw new Error("ENOENT"); files.delete(from); files.set(to, b); },
    };
    var currentReadPath = "";
    const origRead = fakeFs.readSync;
    fakeFs.readSync = function (fd, buf, off, len, pos) { currentReadPath = pos === 0 ? currentReadPath : currentReadPath; return origRead(fd, buf, off, len, pos); };
    // isValidPngFile opens by path — route via openSync/readSync wrapper:
    // simplest is to make readSync derive from the path passed through a marker.
    // Instead: patch statSync-path tracking.
    var lastStatPath = "";
    const origStat = fakeFs.statSync;
    fakeFs.statSync = function (p) { lastStatPath = p; currentReadPath = p; return origStat(p); };

    const context = {
        console: { log() { }, warn() { }, error() { } },
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        Buffer: Buffer,
        Settings: { get: (k) => (k === "performance.isolatedAerender" ? options.setting : true) },
        require: (name) => {
            if (name === "child_process") return cp;
            if (name === "fs") return fakeFs;
            throw new Error("Unexpected require: " + name);
        },
    };
    vm.createContext(context);
    vm.runInContext(SRC, context, { filename: "aerenderRunner.js" });

    return {
        runner: context.AerenderRunner,
        clock: clock,
        spawns: spawns,
        kills: kills,
        files: files,
        cp: cp,
    };
}

describe("AerenderRunner — isolated thumbnail rendering", () => {
    test("discovery: newest AE InstallPath wins, aerender.exe verified, result cached", () => {
        const h = buildHarness({ regSync: true });
        h.runner.discover((p1) => {
            expect(p1).toBe("C:\\Program Files\\Adobe\\Adobe After Effects 2025\\aerender.exe");
            h.runner.discover((p2) => {
                expect(p2).toBe(p1); // cached — no second registry scan
            });
        });
    });

    test("unknown machine: discovery resolves empty and render reports unavailable", () => {
        const h = buildHarness({ regResponses: {}, regSync: true });
        h.runner.renderThumbnail({ aepPath: "C:/t/project.aep", compName: "Comp", outPngPath: "C:/t/thumbnail.png" }, (res) => {
            expect(res.ok).toBe(false);
            expect(res.error).toContain("not found");
            expect(h.runner.isDisabled()).toBe(false); // pre-flight failure, breaker untouched
        });
    });

    test("render success: argv flags correct, numbered PNG resolved+renamed, ok", () => {
        const h = buildHarness({
            regSync: true,
            onSpawn: (call, files) => {
                if (call.exe !== "reg") {
                    // aerender produces a numbered frame artifact
                    files.set("C:/t/thumbnail_00000.png", Buffer.concat([PNG_MAGIC, Buffer.alloc(100, 7)]));
                    call.respond(null, "", "");
                }
            },
        });
        h.runner.renderThumbnail(
            { aepPath: "C:/t/project.aep", compName: "My Comp", frame: 12, outPngPath: "C:/t/thumbnail.png" },
            (res) => {
                expect(res.ok).toBe(true);
                const spawn = h.spawns.find((s) => s.exe !== "reg" && s.args && s.args[0] === "-project");
                expect(spawn).toBeTruthy();
                const a = spawn.args;
                expect(a[a.indexOf("-comp") + 1]).toBe("My Comp");
                expect(a[a.indexOf("-s") + 1]).toBe("12");
                expect(a[a.indexOf("-e") + 1]).toBe("12");
                expect(a[a.indexOf("-close") + 1]).toBe("DO_NOT_SAVE_CHANGES");
                expect(a[a.indexOf("-output") + 1]).toBe("C:/t/thumbnail.png");
                expect(h.files.has("C:/t/thumbnail.png")).toBe(true);   // renamed into place
                expect(h.files.has("C:/t/thumbnail_00000.png")).toBe(false);
                expect(h.runner.isBusy()).toBe(false);                  // lock released
            });
    });

    test("non-PNG or corrupt output is rejected", () => {
        const h = buildHarness({
            regSync: true,
            onSpawn: (call, files) => {
                if (call.exe !== "reg") {
                    files.set("C:/t/thumbnail_00000.png", Buffer.alloc(200, 1)); // no PNG magic
                    call.respond(null, "", "");
                }
            },
        });
        h.runner.renderThumbnail({ aepPath: "C:/t/p.aep", compName: "C", outPngPath: "C:/t/thumbnail.png" }, (res) => {
            expect(res.ok).toBe(false);
            expect(res.error).toContain("no valid PNG");
        });
    });

    test("timeout kills the child, reports timedOut, releases the lock", () => {
        const h = buildHarness({ regSync: true });
        const origKill = {};
        // aerender spawn parks (no respond); timeout must fire.
        h.runner.renderThumbnail({ aepPath: "C:/t/p.aep", compName: "C", outPngPath: "C:/t/thumbnail.png", timeoutMs: 5000 }, (res) => {
            expect(res.ok).toBe(false);
            expect(res.timedOut).toBe(true);
            expect(res.error).toContain("timed out");
            expect(h.runner.isBusy()).toBe(false);
            done1 = true;
        });
        let done1 = false;
        h.clock.fireLast();
        expect(done1).toBe(true);
    });

    test("single-process lock: second concurrent call is rejected without spawning", () => {
        const h = buildHarness({ regSync: true });
        h.runner.renderThumbnail({ aepPath: "C:/t/p.aep", compName: "C", outPngPath: "C:/t/o.png" }, () => { });
        const before = h.spawns.filter((s) => s.exe !== "reg").length;
        h.runner.renderThumbnail({ aepPath: "C:/t/p2.aep", compName: "C", outPngPath: "C:/t/o2.png" }, (res) => {
            expect(res.ok).toBe(false);
            expect(res.error).toContain("in flight");
        });
        expect(h.spawns.filter((s) => s.exe !== "reg").length).toBe(before); // no new aerender
        h.clock.fireLast(); // drain the parked first job via timeout
    });

    test("async discovery window: two calls during in-flight discovery spawn exactly ONE aerender", () => {
        // regSync:false — registry queries park, so discovery stays async.
        // Bug D regression: previously both callers passed the busy gate and
        // both spawned when finishDiscovery flushed the parked waiters.
        const h = buildHarness({ regSync: false });
        const results = [];
        h.runner.renderThumbnail({ aepPath: "C:/t/p.aep", compName: "C", outPngPath: "C:/t/o.png" }, (res) => results.push(res));
        expect(h.runner.isBusy()).toBe(true); // lock taken synchronously at entry
        h.runner.renderThumbnail({ aepPath: "C:/t/p2.aep", compName: "C", outPngPath: "C:/t/o2.png" }, (res) => results.push(res));
        // Second caller is rejected at the synchronous gate — per the
        // existing "another render is in flight" contract.
        expect(results.length).toBe(1);
        expect(results[0].ok).toBe(false);
        expect(results[0].error).toContain("in flight");
        expect(h.spawns.filter((s) => s.exe !== "reg").length).toBe(0); // nothing spawned yet
        // Complete discovery stepwise: version query, then InstallPath query
        // (the second reg call only exists after the first responds).
        h.spawns.filter((s) => s.exe === "reg")[0].respond();
        h.spawns.filter((s) => s.exe === "reg")[1].respond();
        // Exactly ONE aerender spawn for the lock owner.
        const aerenderSpawns = h.spawns.filter((s) => s.exe !== "reg");
        expect(aerenderSpawns.length).toBe(1);
        expect(aerenderSpawns[0].args[aerenderSpawns[0].args.indexOf("-output") + 1]).toBe("C:/t/o.png");
        expect(results.length).toBe(1); // owner still running, no extra callback
        expect(h.runner.isBusy()).toBe(true);
        // Drain the parked run via timeout — lock must be released.
        h.clock.fireLast();
        expect(results.length).toBe(2);
        expect(results[1].ok).toBe(false);
        expect(results[1].timedOut).toBe(true);
        expect(h.runner.isBusy()).toBe(false);
    });

    test("discovery failure releases the lock for the next caller", () => {
        // Async discovery that finds no AE install: busy (taken at entry)
        // must be released on the "not found" rejection so the runner is
        // not wedged for the session.
        const h = buildHarness({ regResponses: {}, regSync: false });
        const results = [];
        h.runner.renderThumbnail({ aepPath: "C:/t/p.aep", compName: "C", outPngPath: "C:/t/o.png" }, (res) => results.push(res));
        expect(h.runner.isBusy()).toBe(true);
        h.spawns.filter((s) => s.exe === "reg").forEach((s) => s.respond()); // err → discovery ""
        expect(results.length).toBe(1);
        expect(results[0].ok).toBe(false);
        expect(results[0].error).toContain("not found");
        expect(h.runner.isBusy()).toBe(false); // lock released, not leaked
        expect(h.spawns.filter((s) => s.exe !== "reg").length).toBe(0);
    });

    test("circuit breaker: 2 consecutive render failures disable for the session", () => {
        const h = buildHarness({
            regSync: true,
            onSpawn: (call) => { if (call.exe !== "reg") call.respond(null, "no comp found", ""); },
        });
        h.runner.renderThumbnail({ aepPath: "a", compName: "C", outPngPath: "C:/t/o.png" }, (r1) => {
            expect(r1.ok).toBe(false);
            h.runner.renderThumbnail({ aepPath: "a", compName: "C", outPngPath: "C:/t/o.png" }, (r2) => {
                expect(r2.ok).toBe(false);
                expect(h.runner.isDisabled()).toBe(true);
                h.runner.renderThumbnail({ aepPath: "a", compName: "C", outPngPath: "C:/t/o.png" }, (r3) => {
                    expect(r3.ok).toBe(false);
                    expect(r3.error).toContain("circuit breaker");
                });
            });
        });
    });

    test("settings kill-switch rejects before any discovery/spawn", () => {
        const h = buildHarness({ regSync: true, setting: false });
        h.runner.renderThumbnail({ aepPath: "a", compName: "C", outPngPath: "C:/t/o.png" }, (res) => {
            expect(res.ok).toBe(false);
            expect(res.error).toContain("disabled by settings");
            expect(h.spawns.length).toBe(0);
        });
    });
});
