// ============================================================
// core/aerenderRunner.js — isolated out-of-process thumbnail render
// ------------------------------------------------------------
// Feature: Wave A — aerender isolation (crash elimination)
//
// Renders a saved template project.aep's thumbnail frame in a SEPARATE
// aerender.exe process so the user's live After Effects session is
// never touched: no scratch import, no in-process memory spikes, no
// render-related crash risk to the open project.
//
// Safety properties:
//   - Discovery ONLY via the installed AE's registry InstallPath —
//     nothing is bundled and no PATH lookup is trusted blindly.
//   - Feature-flagged (Settings "performance.isolatedAerender");
//     every failure falls back to the guarded in-project renderer,
//     so external rendering is never mandatory.
//   - Exactly ONE aerender process at a time (hard lock).
//   - Bounded: per-run timeout kills the process; result is a
//     structured {ok, error, timedOut, durationMs}.
//   - Output validated as PNG (magic bytes + >64 bytes) before it is
//     accepted; aerender's numbered sequence output is resolved and
//     renamed onto the requested path.
//   - Circuit breaker: 2 consecutive failures disable the isolated
//     path for the rest of the session (the in-project path serves
//     everything, as before).
//
// Dependencies are injected (child_process / fs / Settings) so jest
// can drive discovery/lock/timeout/validation without touching the
// real registry or spawning processes. Load AFTER core/bridge.js.
// ============================================================

var AerenderRunner = (function () {
    "use strict";

    var DEFAULT_TIMEOUT_MS = 40000; // must stay under the queue's 60s job budget
    var CIRCUIT_BREAKER_LIMIT = 2;

    var state = {
        discovered: null,        // resolved aerender path ("" = unavailable)
        discoveryDone: false,
        discoveryInFlight: null,
        busy: false,             // single-process lock
        busyClaim: 0,            // claim token of the current lock holder
        consecutiveFailures: 0,
        disabled: false,         // circuit breaker (session-scoped)
    };

    function deps() {
        // Late-bound so the module can load before Node resolvers exist.
        var req = (typeof require !== "undefined") ? require :
            (typeof window !== "undefined" && window.require) ? window.require : null;
        if (!req) return null;
        try { return { cp: req("child_process"), fs: req("fs") }; } catch (e) { return null; }
    }

    function settingsEnabled() {
        try {
            if (typeof Settings === "undefined" || !Settings.get) return false;
            return Settings.get("performance.isolatedAerender") !== false; // default ON
        } catch (e) { return false; }
    }

    // ── Discovery ─────────────────────────────────────────────────────
    // reg query "HKLM\SOFTWARE\Adobe\After Effects"            → version subkeys
    // reg query "HKLM\SOFTWARE\Adobe\After Effects\<v>\InstallPath" /ve → path
    function parseRegValue(line) {
        // Lines look like: "    InstallPath    REG_SZ    C:\Program Files\Adobe\Adobe After Effects 2025\"
        var m = /REG_SZ\s+(.+)$/i.exec(String(line || ""));
        return m ? m[1].trim() : null;
    }

    function discover(cb) {
        if (state.discoveryDone) { cb(state.discovered); return; }
        if (state.discoveryInFlight) { state.discoveryInFlight.push(cb); return; }
        state.discoveryInFlight = [cb];

        var d = deps();
        if (!d) { finishDiscovery(""); return; }

        d.cp.execFile("reg", ["query", "HKLM\\SOFTWARE\\Adobe\\After Effects"], function (err, stdout) {
            if (err) { finishDiscovery(""); return; }
            var versions = [];
            var lines = String(stdout || "").split("\n");
            for (var i = 0; i < lines.length; i++) {
                var m = /HKEY_LOCAL_MACHINE\\SOFTWARE\\Adobe\\After Effects\\([0-9.]+)\s*$/i.exec(lines[i].trim());
                if (m) versions.push(m[1]);
            }
            if (versions.length === 0) { finishDiscovery(""); return; }
            versions.sort(function (a, b) { return parseFloat(b) - parseFloat(a); });

            // Try newest first; first InstallPath with an existing aerender.exe wins.
            function tryNext(index) {
                if (index >= versions.length) { finishDiscovery(""); return; }
                var key = "HKLM\\SOFTWARE\\Adobe\\After Effects\\" + versions[index] + "\\InstallPath";
                d.cp.execFile("reg", ["query", key, "/ve"], function (err2, out2) {
                    if (err2) { tryNext(index + 1); return; }
                    var installPath = null;
                    var outLines = String(out2 || "").split("\n");
                    for (var j = 0; j < outLines.length; j++) {
                        var v = parseRegValue(outLines[j]);
                        if (v) { installPath = v; break; }
                    }
                    if (!installPath) { tryNext(index + 1); return; }
                    var candidate = installPath.replace(/\\+$/, "") + "\\aerender.exe";
                    try {
                        if (d.fs.existsSync(candidate)) { finishDiscovery(candidate); return; }
                    } catch (eFs) { }
                    tryNext(index + 1);
                });
            }
            tryNext(0);
        });

        function finishDiscovery(path) {
            state.discovered = path || "";
            state.discoveryDone = true;
            var waiters = state.discoveryInFlight || [];
            state.discoveryInFlight = null;
            for (var i = 0; i < waiters.length; i++) waiters[i](state.discovered);
        }
    }

    // ── PNG validation ────────────────────────────────────────────────
    function isValidPngFile(fs, filePath) {
        try {
            var stat = fs.statSync(filePath);
            if (!stat.isFile() || stat.size <= 64) return false;
            var fd = fs.openSync(filePath, "r");
            try {
                var buf = Buffer.alloc(8);
                var read = fs.readSync(fd, buf, 0, 8, 0);
                if (read < 8) return false;
                // PNG magic: 89 50 4E 47 0D 0A 1A 0A
                return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
                    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
            } finally {
                try { fs.closeSync(fd); } catch (eC) { }
            }
        } catch (e) {
            return false;
        }
    }

    // aerender sequence outputs land as "name_00000.png" (or "[0]"-style)
    // beside/instead of the requested path — resolve to a real PNG.
    function resolveProducedPng(fs, requestedPath) {
        if (isValidPngFile(fs, requestedPath)) return requestedPath;
        var dir = requestedPath.replace(/\/[^/]*$/, "");
        var base = requestedPath.substring(dir.length + 1).replace(/\.png$/i, "");
        try {
            var entries = fs.readdirSync(dir);
            var best = null;
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i];
                if (e.indexOf(base) !== 0) continue;
                if (!/\.png$/i.test(e)) continue;
                // Numbered frame artifact (base_00000.png / base[0].png)
                if (!/(_\d+|\[\d+\])\.png$/i.test(e)) continue;
                var cand = dir + "/" + e;
                if (isValidPngFile(fs, cand)) {
                    if (!best) best = cand;
                }
            }
            return best;
        } catch (eL) {
            return null;
        }
    }

    // ── Single-process bounded render ─────────────────────────────────
    function renderThumbnail(options, cb) {
        options = options || {};
        var aepPath = options.aepPath;
        var compName = options.compName;
        var frame = (typeof options.frame === "number" && options.frame >= 0) ? Math.floor(options.frame) : 0;
        var outPngPath = options.outPngPath;
        var timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

        if (typeof cb !== "function") cb = function () { };
        if (!aepPath || !compName || !outPngPath) {
            cb({ ok: false, error: "aerender: missing aepPath/compName/outPngPath" });
            return;
        }
        if (state.disabled) {
            cb({ ok: false, error: "aerender: disabled for this session (circuit breaker)" });
            return;
        }
        if (state.busy) {
            cb({ ok: false, error: "aerender: another render is in flight" });
            return;
        }
        if (!settingsEnabled()) {
            cb({ ok: false, error: "aerender: disabled by settings" });
            return;
        }

        // Take the single-process lock SYNCHRONOUSLY, before discovery, so
        // callers arriving while (async) discovery is in flight cannot pass
        // the gate too. Released on every pre-spawn rejection path below;
        // settle() releases it once a run completes/fails/times out.
        state.busy = true;
        state.busyClaim += 1;
        var claim = state.busyClaim;

        discover(function (exePath) {
            if (!exePath) {
                state.busy = false;
                cb({ ok: false, error: "aerender: not found on this machine" });
                return;
            }
            // TOCTOU re-check: parked discovery waiters are flushed in one
            // synchronous loop — only the caller that took the lock may
            // spawn; anyone else must not start a second aerender.exe.
            if (!state.busy || state.busyClaim !== claim) {
                cb({ ok: false, error: "aerender: another render is in flight" });
                return;
            }
            var d = deps();
            if (!d) { state.busy = false; cb({ ok: false, error: "aerender: Node unavailable" }); return; }

            var t0 = Date.now();
            var settled = false;
            var child = null;

            function settle(result) {
                if (settled) return;
                settled = true;
                state.busy = false;
                if (timer) { clearTimeout(timer); timer = null; }
                result.durationMs = Date.now() - t0;
                if (result.ok) {
                    state.consecutiveFailures = 0;
                } else if (!result.timedOut && result.error &&
                    result.error.indexOf("aerender:") === 0) {
                    // Pre-flight guard failures do not count against the breaker.
                } else {
                    state.consecutiveFailures++;
                    if (state.consecutiveFailures >= CIRCUIT_BREAKER_LIMIT) {
                        state.disabled = true;
                        try { console.warn("[CompSaver aerender] circuit breaker open — using in-project renderer for this session"); } catch (eL) { }
                    }
                }
                cb(result);
            }

            var timer = setTimeout(function () {
                try { if (child) child.kill(); } catch (eK) { }
                settle({ ok: false, timedOut: true, error: "aerender: timed out after " + timeoutMs + "ms" });
            }, timeoutMs);

            // execFile with an argv array: no shell, no quoting hazards.
            var args = [
                "-project", aepPath,
                "-comp", compName,
                "-RStemplate", "Best Settings",
                "-OMtemplate", "PNG Sequence with Alpha",
                "-s", String(frame),
                "-e", String(frame),
                "-output", outPngPath,
                "-close", "DO_NOT_SAVE_CHANGES"
            ];

            try {
                child = d.cp.execFile(exePath, args, { timeout: timeoutMs + 5000, windowsVerbatimArguments: false },
                    function (err, stdout, stderr) {
                        if (settled) return; // timeout already fired
                        var produced = resolveProducedPng(d.fs, outPngPath);
                        if (produced) {
                            if (produced !== outPngPath) {
                                try { d.fs.renameSync(produced, outPngPath); }
                                catch (eRen) {
                                    settle({ ok: false, error: "aerender: could not move output into place" });
                                    return;
                                }
                            }
                            settle({ ok: true });
                            return;
                        }
                        var tail = String(stderr || stdout || "").replace(/\s+/g, " ").slice(-160);
                        settle({ ok: false, error: "aerender: no valid PNG produced" + (tail ? " — " + tail : "") + (err ? " — " + err : "") });
                    });
            } catch (eSpawn) {
                settle({ ok: false, error: "aerender: spawn failed — " + (eSpawn && eSpawn.message ? eSpawn.message : String(eSpawn)) });
            }
        });
    }

    function resetForTests() {
        state.discovered = null;
        state.discoveryDone = false;
        state.discoveryInFlight = null;
        state.busy = false;
        state.busyClaim = 0;
        state.consecutiveFailures = 0;
        state.disabled = false;
    }

    return {
        renderThumbnail: renderThumbnail,
        discover: discover,
        resetForTests: resetForTests,
        isDisabled: function () { return state.disabled; },
        isBusy: function () { return state.busy; },
        DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS
    };
})();
