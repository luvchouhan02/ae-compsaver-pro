/**
 * Shared static-analysis helpers for the panel-visual-redesign contract tests.
 *
 * These utilities read the project's source files as TEXT (no DOM, no bundler)
 * and extract the structural facts the contract tests assert on:
 *   - the ordered @import list in css/style.css
 *   - the CSS files present on disk and how they are wired into the panel
 *   - the selectors the JavaScript depends on (getElementById, querySelector*,
 *     classList.*, dataset.*, and data-* attributes authored in HTML)
 *   - the static interactive-element / id inventory of index.html
 *
 * Everything here is pure parsing so the tests stay deterministic and run in a
 * Node environment (see jest.config.js: testEnvironment "node").
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CSS_DIR = path.join(ROOT, "css");
const INDEX_HTML = path.join(ROOT, "index.html");

/** Read a UTF-8 file relative to the project root. */
function read(relOrAbs) {
    const p = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs);
    return fs.readFileSync(p, "utf8");
}

/** List every *.css file inside css/ (just the base names, e.g. "base.css"). */
function listCssFiles() {
    return fs
        .readdirSync(CSS_DIR)
        .filter((f) => f.toLowerCase().endsWith(".css"))
        .sort();
}

/** Recursively collect every *.js file under js/ as absolute paths. */
function listJsFiles() {
    const jsDir = path.join(ROOT, "js");
    const out = [];
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.toLowerCase().endsWith(".js")) out.push(full);
        }
    })(jsDir);
    return out.sort();
}

/** Concatenate the text of every JavaScript file under js (definition universe). */
function readAllJs() {
    return listJsFiles()
        .map((f) => fs.readFileSync(f, "utf8"))
        .join("\n");
}

/** Concatenate the text of every css/*.css file (used as a definition universe). */
function readAllCss() {
    return listCssFiles()
        .map((f) => fs.readFileSync(path.join(CSS_DIR, f), "utf8"))
        .join("\n");
}

/**
 * Parse the ordered @import list out of style.css.
 * Returns module base names without extension or version query,
 * e.g. ["base", "header", ...] preserving authored order.
 */
function parseStyleImports(styleCss) {
    const re = /@import\s+url\(\s*["']([^"')?]+)/g;
    const out = [];
    let m;
    while ((m = re.exec(styleCss)) !== null) {
        out.push(m[1].replace(/\.css$/i, ""));
    }
    return out;
}

/** Find every css/<file>.css referenced by a <link> tag in index.html. */
function parseLinkedCss(html) {
    const re = /<link[^>]+href=["']css\/([^"'?]+)/gi;
    const out = new Set();
    let m;
    while ((m = re.exec(html)) !== null) out.add(m[1]);
    return out;
}

/**
 * Extract every id="..." in the HTML, partitioned so callers can ask for all
 * ids or just ids that belong to interactive elements.
 */
const INTERACTIVE_TAGS = ["button", "input", "select", "textarea", "a", "option"];

function extractAllIds(html) {
    const re = /\bid="([^"]+)"/g;
    const out = new Set();
    let m;
    while ((m = re.exec(html)) !== null) out.add(m[1]);
    return out;
}

/**
 * Extract ids that sit on interactive elements (button/input/select/textarea/a/option).
 * Tags may span multiple lines; [^>] matches newlines so the per-tag scan is safe.
 */
function extractInteractiveIds(html) {
    const tagRe = new RegExp(
        "<(" + INTERACTIVE_TAGS.join("|") + ")\\b([^>]*)>",
        "gi"
    );
    const idRe = /\bid="([^"]+)"/;
    const out = new Set();
    let m;
    while ((m = tagRe.exec(html)) !== null) {
        const attrs = m[2];
        const idMatch = idRe.exec(attrs);
        if (idMatch) out.add(idMatch[1]);
    }
    return out;
}

/** Extract the set of data-* attribute names authored in the HTML (e.g. "data-target"). */
function extractHtmlDataAttrs(html) {
    const re = /\b(data-[a-z0-9-]+)=/gi;
    const out = new Set();
    let m;
    while ((m = re.exec(html)) !== null) out.add(m[1].toLowerCase());
    return out;
}

/** camelCase dataset key -> kebab data-* attribute name (saveType -> data-save-type). */
function datasetKeyToAttr(key) {
    return "data-" + key.replace(/([A-Z])/g, "-$1").toLowerCase();
}

/**
 * Extract the selectors the JavaScript depends on from a blob of JS text.
 * Returns:
 *   ids       - Set of ids passed to getElementById(...)
 *   classes   - Set of class names passed to classList.{add,remove,toggle,contains,replace}(...)
 *   dataAttrs - Set of data-* attribute names implied by dataset.X access
 *   selectors - raw selector strings passed to querySelector / querySelectorAll
 */
function extractJsRefs(jsText) {
    const ids = new Set();
    const classes = new Set();
    const dataAttrs = new Set();
    const selectors = new Set();

    let m;

    const idRe = /getElementById\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
    while ((m = idRe.exec(jsText)) !== null) ids.add(m[1]);

    // classList.method("a", "b", ...) — capture every string-literal argument.
    const clRe = /classList\.(?:add|remove|toggle|contains|replace)\(([^)]*)\)/g;
    while ((m = clRe.exec(jsText)) !== null) {
        const argStr = m[1];
        const litRe = /["'`]([^"'`]+)["'`]/g;
        let lit;
        while ((lit = litRe.exec(argStr)) !== null) {
            // add/remove/contains may take several class literals; toggle's
            // second argument is a boolean expression, not a string literal, so
            // only genuine single-token class names are captured here.
            const token = lit[1];
            if (/^[A-Za-z][\w-]*$/.test(token)) classes.add(token);
        }
    }

    const dsRe = /\.dataset\.([A-Za-z_][A-Za-z0-9_]*)/g;
    while ((m = dsRe.exec(jsText)) !== null) dataAttrs.add(datasetKeyToAttr(m[1]));

    const qsRe = /querySelector(?:All)?\(\s*["'`]([^"'`]+)["'`]/g;
    while ((m = qsRe.exec(jsText)) !== null) selectors.add(m[1]);

    return { ids, classes, dataAttrs, selectors };
}

/** Pull every .class token out of a CSS blob (selector class names only). */
function extractCssClasses(cssText) {
    const re = /\.(-?[A-Za-z_][\w-]*)/g;
    const out = new Set();
    let m;
    while ((m = re.exec(cssText)) !== null) out.add(m[1]);
    return out;
}

/** Pull every class token authored in HTML class="..." attributes. */
function extractHtmlClasses(html) {
    const re = /\bclass="([^"]+)"/g;
    const out = new Set();
    let m;
    while ((m = re.exec(html)) !== null) {
        for (const tok of m[1].split(/\s+/)) {
            if (tok) out.add(tok);
        }
    }
    return out;
}

/** Pull every data-* attribute referenced anywhere in a CSS blob. */
function extractCssDataAttrs(cssText) {
    const re = /\[\s*(data-[a-z0-9-]+)/gi;
    const out = new Set();
    let m;
    while ((m = re.exec(cssText)) !== null) out.add(m[1].toLowerCase());
    return out;
}

/** Extract data-* attribute names referenced inside querySelector selector strings. */
function dataAttrsFromSelectors(selectors) {
    const out = new Set();
    const re = /\[\s*(data-[a-z0-9-]+)/gi;
    for (const sel of selectors) {
        let m;
        while ((m = re.exec(sel)) !== null) out.add(m[1].toLowerCase());
    }
    return out;
}

/* ------------------------------------------------------------------------- */
/* Composed_Markup (obsidian-ui-redesign, Req 3.10, 3.11)                     */
/*                                                                           */
/* The Shell (index.html) carries one empty `data-view-mount="<name>"`       */
/* element per CompSaverViews.MANIFEST entry. composeMarkup() inserts each   */
/* View_Fragment (views/<name>.html) once at its mount, which is the same    */
/* DOM the Panel builds at runtime. Any structural problem throws a          */
/* ComposeError, so a suite composing at module scope fails to run instead   */
/* of asserting against partial markup.                                      */
/* ------------------------------------------------------------------------- */

const VIEWS_DIR = path.join(ROOT, "views");
const VIEW_LOADER = path.join(ROOT, "js", "ui", "view-loader.js");
const SHELL_FILE = "index.html";
const BOM = "\uFEFF";

/** Error thrown by composeMarkup(); `code` is one of the COMPOSE_* codes below. */
class ComposeError extends Error {
    constructor(code, message, details) {
        super("[" + code + "] " + message);
        this.name = "ComposeError";
        this.code = code;
        this.fragment = (details && details.fragment) || null;
        this.mount = details && details.mount !== undefined ? details.mount : null;
        if (details && details.count !== undefined) this.count = details.count;
        if (details && details.construct !== undefined) this.construct = details.construct;
    }
}

/**
 * The runtime's own fragment list (js/ui/view-loader.js MANIFEST).
 * Returns [] while the loader does not exist yet (before the Shell split).
 */
function viewManifest() {
    if (!fs.existsSync(VIEW_LOADER)) return [];
    const mod = require(VIEW_LOADER);
    if (!mod || !Array.isArray(mod.MANIFEST)) {
        throw new Error("js/ui/view-loader.js does not export a MANIFEST array");
    }
    return Array.from(mod.MANIFEST);
}

/** Normalize a manifest entry (object or bare name) to { name, file }. */
function normalizeViewEntry(entry) {
    const e = typeof entry === "string" ? { name: entry } : entry || {};
    const name = String(e.name);
    const file =
        typeof e.file === "string" && e.file
            ? e.file.replace(/\\/g, "/")
            : "views/" + name + ".html";
    return { name, file };
}

/** Default fragment reader: file text, or null when the file does not exist. */
function readFragmentFromDisk(file) {
    try {
        return fs.readFileSync(path.join(ROOT, file), "utf8");
    } catch (err) {
        if (err && err.code === "ENOENT") return null;
        throw err;
    }
}

/** Blank out quoted attribute values so attribute-name scans ignore their text. */
function stripAttrValues(attrs) {
    return attrs.replace(/"[^"]*"|'[^']*'/g, '""');
}

// Opening tag with a name and an attribute string; quoted values may hold ">".
const OPEN_TAG_RE = /<([A-Za-z][A-Za-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
// data-view-mount attribute (name boundary required) with an optional value.
const MOUNT_ATTR_RE =
    /(?:^|\s)data-view-mount(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?(?=[\s/]|$)/i;

/** Every mount opening tag in the Shell, in document order. */
function findMountTags(shellText) {
    const out = [];
    const re = new RegExp(OPEN_TAG_RE.source, "g");
    let m;
    while ((m = re.exec(shellText)) !== null) {
        const attr = MOUNT_ATTR_RE.exec(m[2]);
        if (!attr) continue;
        const value = attr[1] !== undefined ? attr[1] : attr[2] !== undefined ? attr[2] : attr[3] || "";
        out.push({ value, tag: m[1], start: m.index, openEnd: m.index + m[0].length });
    }
    return out;
}

const FORBIDDEN_TAGS = ["script", "link", "style", "html", "head", "body"];

/** First fragment-rule violation in the text, or null when the fragment is clean. */
function findForbiddenConstruct(text) {
    if (/<!doctype\b/i.test(text)) return "<!DOCTYPE>";
    for (const tag of FORBIDDEN_TAGS) {
        if (new RegExp("<" + tag + "\\b", "i").test(text)) return "<" + tag + ">";
    }
    const re = new RegExp(OPEN_TAG_RE.source, "g");
    let m;
    while ((m = re.exec(text)) !== null) {
        const names = stripAttrValues(m[2]);
        const on = /(?:^|\s)(on[A-Za-z]+)\s*=/.exec(names);
        if (on) return "inline handler attribute " + on[1] + "= on <" + m[1] + ">";
        if (/(?:^|\s)data-view-mount(?=[\s=/]|$)/i.test(names)) {
            return "data-view-mount attribute on <" + m[1] + ">";
        }
    }
    return null;
}

/**
 * Build the Composed_Markup: the Shell with every View_Fragment inserted once
 * at its mount. Options (all optional, for in-memory fixtures):
 *   shellText    - Shell markup (default: index.html on disk)
 *   readFragment - (file, entry) => text, or null/undefined when missing
 *                  (a thrown error with code ENOENT also counts as missing)
 *   manifest     - fragment entries { name, file? } (default: viewManifest())
 * No caching and no line-ending rewrite: the same inputs give the same string.
 */
function composeMarkup(options) {
    const opts = options || {};
    const shell = typeof opts.shellText === "string" ? opts.shellText : read(INDEX_HTML);
    const readFragment = typeof opts.readFragment === "function" ? opts.readFragment : readFragmentFromDisk;
    const entries = (Array.isArray(opts.manifest) ? opts.manifest : viewManifest()).map(normalizeViewEntry);
    const known = new Set(entries.map((e) => e.name));

    // Step 2: one mount per value, and every mount value belongs to the manifest.
    const mounts = findMountTags(shell);
    const counts = new Map();
    for (const mt of mounts) counts.set(mt.value, (counts.get(mt.value) || 0) + 1);
    for (const [value, count] of counts) {
        if (count > 1) {
            throw new ComposeError(
                "MOUNT_DUPLICATE",
                'data-view-mount="' + value + '" appears ' + count + " times in " + SHELL_FILE + " (expected once)",
                { mount: value, count }
            );
        }
    }
    for (const mt of mounts) {
        if (!known.has(mt.value)) {
            throw new ComposeError(
                "MOUNT_UNKNOWN",
                'data-view-mount="' + mt.value + '" in ' + SHELL_FILE + " is not in the view manifest",
                { mount: mt.value }
            );
        }
    }

    const inserts = [];
    for (const entry of entries) {
        const mt = mounts.find((x) => x.value === entry.name);
        if (!mt) {
            throw new ComposeError(
                "MOUNT_MISSING",
                "fragment " + entry.file + ' has no mount: expected data-view-mount="' + entry.name + '" in ' + SHELL_FILE,
                { fragment: entry.file, mount: entry.name }
            );
        }
        const closeRe = new RegExp("</" + mt.tag + "\\s*>", "ig");
        closeRe.lastIndex = mt.openEnd;
        const close = closeRe.exec(shell);
        if (!close) {
            throw new ComposeError(
                "MOUNT_NOT_EMPTY",
                'data-view-mount="' + entry.name + '" has no closing </' + mt.tag + "> in " + SHELL_FILE,
                { fragment: entry.file, mount: entry.name }
            );
        }
        if (/\S/.test(shell.slice(mt.openEnd, close.index))) {
            throw new ComposeError(
                "MOUNT_NOT_EMPTY",
                'data-view-mount="' + entry.name + '" already holds markup in ' + SHELL_FILE + " (only whitespace allowed)",
                { fragment: entry.file, mount: entry.name }
            );
        }

        // Step 3: read, strip a leading BOM, check the fragment rules.
        let text;
        try {
            text = readFragment(entry.file, entry);
        } catch (err) {
            if (!(err && err.code === "ENOENT")) throw err;
            text = null;
        }
        if (text === null || text === undefined) {
            throw new ComposeError(
                "FRAGMENT_MISSING",
                "fragment " + entry.file + ' for data-view-mount="' + entry.name + '" does not exist',
                { fragment: entry.file, mount: entry.name }
            );
        }
        text = String(text);
        if (text.charAt(0) === BOM) text = text.slice(1);
        if (!/\S/.test(text)) {
            throw new ComposeError("FRAGMENT_EMPTY", "fragment " + entry.file + " is empty or whitespace only", {
                fragment: entry.file,
                mount: entry.name,
            });
        }
        const construct = findForbiddenConstruct(text);
        if (construct) {
            throw new ComposeError("FRAGMENT_FORBIDDEN", "fragment " + entry.file + " contains " + construct, {
                fragment: entry.file,
                mount: entry.name,
                construct,
            });
        }
        inserts.push({ from: mt.openEnd, to: close.index, text });
    }

    // Step 4: insert from the end of the Shell backwards so earlier offsets stay valid.
    // The mount's whitespace-only content is replaced, as `mount.innerHTML = text` does.
    inserts.sort((a, b) => b.from - a.from);
    let out = shell;
    for (const ins of inserts) out = out.slice(0, ins.from) + ins.text + out.slice(ins.to);
    return out;
}

/** Markup files for file scanners: the Shell, then each fragment in manifest order. */
function listMarkupFiles(options) {
    const opts = options || {};
    const entries = (Array.isArray(opts.manifest) ? opts.manifest : viewManifest()).map(normalizeViewEntry);
    return [SHELL_FILE].concat(entries.map((e) => e.file));
}

module.exports = {
    ROOT,
    CSS_DIR,
    INDEX_HTML,
    VIEWS_DIR,
    viewManifest,
    composeMarkup,
    listMarkupFiles,
    ComposeError,
    read,
    listCssFiles,
    listJsFiles,
    readAllJs,
    readAllCss,
    parseStyleImports,
    parseLinkedCss,
    extractAllIds,
    extractInteractiveIds,
    extractHtmlDataAttrs,
    extractHtmlClasses,
    datasetKeyToAttr,
    extractJsRefs,
    extractCssClasses,
    extractCssDataAttrs,
    dataAttrsFromSelectors,
};
