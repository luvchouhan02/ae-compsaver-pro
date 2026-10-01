/**
 * Test_Baseline comparison for the Obsidian UI redesign (Req 3.1, 3.2, 20.1, 20.2).
 *
 * Run with:  npx jest --json --outputFile=<jest-json>
 *            node tests/helpers/compare-test-baseline.js <jest-json> [fixture-json]
 *
 * The fixture defaults to tests/fixtures/obsidian-test-baseline.json.
 *
 * A run is inside the Test_Baseline when:
 *   - the suite count is at least fixture.minimums.suites (130) and the test count
 *     is at least fixture.minimums.tests (1,587), and
 *   - every failing suite file is listed in fixture.failingSuites, and
 *   - every failing test (suite file + full test name) is listed in fixture.failingTests.
 * Fewer failures than the fixture is fine (a subset).
 *
 * Before reporting, every failing suite file with a failure outside the fixture is
 * re-run once in isolation (`jest --runTestsByPath`); it is reported only if it
 * still has a failure outside the fixture on that re-run. The retried suites are
 * printed.
 *
 * Exits 0 when the run is inside the Test_Baseline, 1 otherwise, 2 on a usage or
 * I/O error. This file is not collected by Jest (it does not end in .test.js).
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_FIXTURE = path.join(REPO_ROOT, "tests", "fixtures", "obsidian-test-baseline.json");
const JEST_BIN = path.join(REPO_ROOT, "node_modules", "jest", "bin", "jest.js");

/** Suite file path relative to the repo root, with forward slashes. */
function suiteKey(name) {
    const abs = path.isAbsolute(name) ? name : path.resolve(REPO_ROOT, name);
    return path.relative(REPO_ROOT, abs).replace(/\\/g, "/");
}

function testKey(suite, fullName) {
    return suite + "\u0000" + fullName;
}

/**
 * Failures of a Jest JSON result that are outside the fixture, grouped by suite.
 * Returns Map<suite, { suiteFailed: boolean, suiteListed: boolean, tests: string[], message: string }>.
 */
function extraFailures(jestJson, fixture) {
    const listedSuites = new Set(fixture.failingSuites || []);
    const listedTests = new Set((fixture.failingTests || []).map((t) => testKey(t.suite, t.fullName)));
    const extras = new Map();

    for (const result of jestJson.testResults || []) {
        const suite = suiteKey(result.name);
        const failedTests = (result.assertionResults || [])
            .filter((a) => a.status === "failed")
            .map((a) => a.fullName);
        const suiteFailed = result.status === "failed" || failedTests.length > 0;
        if (!suiteFailed) continue;

        const suiteListed = listedSuites.has(suite);
        const extraTests = failedTests.filter((name) => !listedTests.has(testKey(suite, name)));
        if (suiteListed && extraTests.length === 0) continue;

        extras.set(suite, {
            suiteFailed,
            suiteListed,
            tests: extraTests,
            message: failedTests.length === 0 ? firstLine(result.message || result.testExecError?.message || "") : "",
        });
    }
    return extras;
}

function firstLine(text) {
    const line = String(text)
        .replace(/\u001b\[[0-9;]*m/g, "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
    return line || "";
}

/** Re-runs one suite file in isolation and returns its Jest JSON, or null if no JSON was produced. */
function rerunSuite(suite) {
    const outFile = path.join(os.tmpdir(), `compare-test-baseline-${process.pid}-${Date.now()}.json`);
    try {
        spawnSync(
            process.execPath,
            [JEST_BIN, "--json", `--outputFile=${outFile}`, "--runTestsByPath", path.join(REPO_ROOT, suite)],
            { cwd: REPO_ROOT, stdio: "ignore", windowsHide: true }
        );
        if (!fs.existsSync(outFile)) return null;
        return JSON.parse(fs.readFileSync(outFile, "utf8"));
    } finally {
        try {
            fs.unlinkSync(outFile);
        } catch (_) {
            /* already gone */
        }
    }
}

function readJson(file, label) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
        throw new Error(`cannot read ${label} ${file}: ${err.message}`);
    }
}

function main(argv) {
    if (!argv[0]) {
        console.error("usage: node tests/helpers/compare-test-baseline.js <jest-json> [fixture-json]");
        return 2;
    }
    const jestJson = readJson(path.resolve(argv[0]), "Jest JSON");
    const fixture = readJson(path.resolve(argv[1] || DEFAULT_FIXTURE), "fixture");
    const minSuites = (fixture.minimums && fixture.minimums.suites) || 130;
    const minTests = (fixture.minimums && fixture.minimums.tests) || 1587;

    const problems = [];
    const suites = jestJson.numTotalTestSuites;
    const tests = jestJson.numTotalTests;
    console.log(
        `compare-test-baseline: ${suites} suites (${jestJson.numFailedTestSuites} failed), ` +
        `${tests} tests (${jestJson.numFailedTests} failed)`
    );
    if (!(suites >= minSuites)) problems.push(`suite count ${suites} is below ${minSuites}`);
    if (!(tests >= minTests)) problems.push(`test count ${tests} is below ${minTests}`);

    let extras = extraFailures(jestJson, fixture);

    if (extras.size > 0) {
        const retried = Array.from(extras.keys()).sort();
        console.log(`compare-test-baseline: retrying ${retried.length} suite(s) outside the fixture once:`);
        for (const suite of retried) console.log(`  ${suite}`);

        const confirmed = new Map();
        for (const suite of retried) {
            const rerun = rerunSuite(suite);
            const ranSuite = rerun && (rerun.testResults || []).some((r) => suiteKey(r.name) === suite);
            if (!ranSuite) {
                confirmed.set(suite, extras.get(suite));
                console.log(`  ${suite}: re-run produced no result for this suite, keeping the original failure`);
                continue;
            }
            const again = extraFailures(rerun, fixture).get(suite);
            if (again) {
                confirmed.set(suite, again);
                console.log(`  ${suite}: failed again`);
            } else {
                console.log(`  ${suite}: passed on re-run (flaky), not reported`);
            }
        }
        extras = confirmed;
    }

    for (const suite of Array.from(extras.keys()).sort()) {
        const e = extras.get(suite);
        if (!e.suiteListed) {
            problems.push(`failing suite not in the Test_Baseline: ${suite}${e.message ? ` (${e.message})` : ""}`);
        }
        for (const name of e.tests) problems.push(`failing test not in the Test_Baseline: ${suite} > ${name}`);
    }

    if (problems.length === 0) {
        console.log("compare-test-baseline: OK, failures are within the Test_Baseline");
        return 0;
    }
    console.error(`compare-test-baseline: FAILED, ${problems.length} problem(s) outside the Test_Baseline:`);
    for (const p of problems) console.error(`  ${p}`);
    return 1;
}

module.exports = { suiteKey, extraFailures };

if (require.main === module) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (err) {
        console.error(`compare-test-baseline: ${err && err.message ? err.message : err}`);
        process.exitCode = 2;
    }
}
