/**
 * js/core additive-only guard for the Obsidian UI redesign (Req 1.7, 3.1, 20.1).
 *
 * Run with:  node tests/helpers/check-js-core-additive.js [snapshotDir] [currentDir]
 *
 * Defaults:
 *   snapshotDir = .kiro/specs/obsidian-ui-redesign/baseline/js-core
 *   currentDir  = js/core
 *
 * For every file in the snapshot, every snapshot line must still appear in the
 * current js/core file, in the same relative order (the snapshot must be a
 * subsequence of the current file). Lines may be added anywhere; no line may be
 * removed or changed. Files that are new in js/core are allowed.
 *
 * Lines are compared after stripping a trailing "\r", so a CRLF/LF-only change is
 * not reported as a removed line.
 *
 * Exits 0 when every snapshot file passes. Otherwise prints each failing file with
 * its first missing line and exits 1. Exits 2 on a usage or I/O error.
 *
 * This file is not collected by Jest (it does not end in .test.js).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_SNAPSHOT = path.join(REPO_ROOT, ".kiro", "specs", "obsidian-ui-redesign", "baseline", "js-core");
const DEFAULT_CURRENT = path.join(REPO_ROOT, "js", "core");

function splitLines(text) {
    return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Greedy subsequence check. Returns null when every snapshot line is found in
 * order in the current lines, otherwise { index, line } for the first snapshot
 * line that cannot be matched (index is zero-based in the snapshot file).
 */
function firstMissingLine(snapshotLines, currentLines) {
    let cursor = 0;
    for (let i = 0; i < snapshotLines.length; i++) {
        const wanted = snapshotLines[i];
        while (cursor < currentLines.length && currentLines[cursor] !== wanted) cursor++;
        if (cursor >= currentLines.length) return { index: i, line: wanted };
        cursor++;
    }
    return null;
}

/**
 * Compares a snapshot directory with a current directory.
 * Returns a list of { file, reason, lineNumber?, line? } problems (empty when additive).
 */
function checkAdditive(snapshotDir, currentDir) {
    const problems = [];
    const files = fs
        .readdirSync(snapshotDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();

    for (const name of files) {
        const currentPath = path.join(currentDir, name);
        if (!fs.existsSync(currentPath)) {
            problems.push({ file: name, reason: "file missing from current directory" });
            continue;
        }
        const snapshotLines = splitLines(fs.readFileSync(path.join(snapshotDir, name), "utf8"));
        const currentLines = splitLines(fs.readFileSync(currentPath, "utf8"));
        const missing = firstMissingLine(snapshotLines, currentLines);
        if (missing) {
            problems.push({
                file: name,
                reason: "snapshot line removed, changed or reordered",
                lineNumber: missing.index + 1,
                line: missing.line,
            });
        }
    }
    return { files, problems };
}

function main(argv) {
    const snapshotDir = path.resolve(argv[0] || DEFAULT_SNAPSHOT);
    const currentDir = path.resolve(argv[1] || DEFAULT_CURRENT);

    if (!fs.existsSync(snapshotDir) || !fs.statSync(snapshotDir).isDirectory()) {
        console.error(`check-js-core-additive: snapshot directory not found: ${snapshotDir}`);
        return 2;
    }
    if (!fs.existsSync(currentDir) || !fs.statSync(currentDir).isDirectory()) {
        console.error(`check-js-core-additive: current directory not found: ${currentDir}`);
        return 2;
    }

    const { files, problems } = checkAdditive(snapshotDir, currentDir);
    if (problems.length === 0) {
        console.log(`check-js-core-additive: OK, ${files.length} snapshot file(s) are additive-only in ${currentDir}`);
        return 0;
    }

    console.error(`check-js-core-additive: FAILED, ${problems.length} file(s) are not additive-only:`);
    for (const p of problems) {
        if (p.lineNumber) {
            console.error(`  ${p.file}: ${p.reason}; first missing snapshot line ${p.lineNumber}:`);
            console.error(`    ${JSON.stringify(p.line)}`);
        } else {
            console.error(`  ${p.file}: ${p.reason}`);
        }
    }
    return 1;
}

module.exports = { splitLines, firstMissingLine, checkAdditive };

if (require.main === module) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (err) {
        console.error(`check-js-core-additive: ${err && err.stack ? err.stack : err}`);
        process.exitCode = 2;
    }
}
