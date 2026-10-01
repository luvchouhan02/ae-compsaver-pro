// ============================================================
// tests/paste-lifecycle.test.js
//
// Feature: Toolkit quality wave — Paste Image lifecycle
//
// What is under test
// ------------------
// The REAL PasteController + ToolBridge (js/ui/paste.js +
// js/core/toolBridge.js) in one vm realm. The Node fs module is a
// fake with ASYNCHRONOUS write/unlink; FileReader is faked; the
// host callback is delivered manually. Verifies:
//   - single-flight: overlapping pastes fire ONE import
//   - collision-safe temp names
//   - temp cleanup on success AND on timeout
//   - text paste untouched (no preventDefault, no dispatch)
//   - preventDefault only after an image is accepted
//   - init idempotency (one window paste listener)
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const PASTE_SOURCE = fs.readFileSync(path.join(ROOT, "js/ui/paste.js"), "utf8");
const BRIDGE_SOURCE = fs.readFileSync(path.join(ROOT, "js/core/toolBridge.js"), "utf8");

function manualClock() {
    const timers = [];
    let nextId = 1;
    return {
        setTimeout: function (fn) { timers.push({ id: nextId, fn: fn, done: false }); return nextId++; },
        clearTimeout: function (handle) { const t = timers.find(function (x) { return x.id === handle; }); if (t) t.done = true; },
        advance: function () { const due = timers.filter(function (t) { return !t.done; }); due.forEach(function (t) { if (!t.done) t.fn(); }); return due.length; },
        pending: function () { return timers.filter(function (t) { return !t.done; }).length; },
    };
}

function FakeFileReader() {
    this.result = null;
    this.onload = null;
    this.onerror = null;
}
FakeFileReader.prototype.readAsArrayBuffer = function (blob) {
    this.result = blob.bytes;
    if (this.onload) this.onload();
};

function buildHarness() {
    const clock = manualClock();
    const written = [];   // { path, buffer, done(err) }
    const unlinked = [];  // paths
    const hostCalls = []; // { script, respond }
    const toasts = [];
    const listeners = { window: {} };

    const fakePath = { join: function () { return Array.prototype.join.call(arguments, "/"); } };
    const fakeOs = { tmpdir: function () { return "C:/TEMP"; } };
    const fakeFs = {
        writeFile: function (p, buffer, cb) {
            const record = { path: p, buffer: buffer };
            written.push(record);
            // Async completion on the next macrotask — the panel must not
            // observe the write synchronously.
            clock.setTimeout(function () { cb(null); });
        },
        unlink: function (p, cb) { unlinked.push(p); cb(); },
    };

    const context = {
        console: { log: function () { }, warn: function () { }, error: function () { } },
        performance: { now: function () { return Date.now(); } },
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        showToast: function (message, kind) { toasts.push({ message: message, kind: kind }); },
        encodeBridge: function (s) { return "hex(" + s + ")"; },
        decodeBridge: function (s) { return String(s); },
        FileReader: FakeFileReader,
        Buffer: Buffer,
        require: function (name) {
            if (name === "fs") return fakeFs;
            if (name === "path") return fakePath;
            if (name === "os") return fakeOs;
            throw new Error("Unexpected require: " + name);
        },
        window: null,
        csInterface: {
            evalScript: function (script, cb) { hostCalls.push({ script: script, respond: cb }); },
        },
        SystemPath: { USER_DATA: "USER_DATA" },
    };
    context.window = {
        addEventListener: function (name, handler) { listeners.window[name] = handler; },
        btoa: function (s) { return Buffer.from(s, "binary").toString("base64"); },
        require: context.require,
    };
    vm.createContext(context);
    vm.runInContext(BRIDGE_SOURCE, context, { filename: "toolBridge.js" });
    vm.runInContext(PASTE_SOURCE, context, { filename: "paste.js" });

    return {
        context: context,
        clock: clock,
        toasts: toasts,
        written: written,
        unlinked: unlinked,
        hostCalls: hostCalls,
        listeners: listeners,
        PasteController: context.PasteController,
        initClipboardPaste: context.initClipboardPaste,
        fakeFs: fakeFs,
        respondHost: function (value) { hostCalls[hostCalls.length - 1].respond(value); },
    };
}

function imageBlob() {
    return { bytes: new Uint8Array([1, 2, 3, 4]).buffer, type: "image/png" };
}

describe("PasteController — bounded paste lifecycle", () => {
    test("happy path: async write, ONE import, temp cleaned on success, latch released", () => {
        const h = buildHarness();
        h.PasteController.handlePasteBlob(imageBlob());

        expect(h.written.length).toBe(1);                      // temp written
        expect(h.hostCalls.length).toBe(0);                    // import waits for the async write
        h.clock.advance();                                     // write completes
        expect(h.hostCalls.length).toBe(1);                    // import dispatched
        expect(h.hostCalls[0].script).toContain("toolkitImportPastedImage");

        h.respondHost("OK:Imported 1");
        expect(h.unlinked).toEqual([h.written[0].path]);       // cleanup on success
        expect(h.toasts.some((t) => t.kind === "success")).toBe(true);

        // Latch released: a second paste dispatches again.
        h.PasteController.handlePasteBlob(imageBlob());
        h.clock.advance();
        expect(h.hostCalls.length).toBe(2);
    });

    test("single-flight: an overlapping paste is rejected with a toast, one import total", () => {
        const h = buildHarness();
        h.PasteController.handlePasteBlob(imageBlob());
        h.clock.advance();                                     // first import in flight
        h.PasteController.handlePasteBlob(imageBlob());

        expect(h.hostCalls.length).toBe(1);
        expect(h.toasts.some((t) => t.message.indexOf("already in progress") !== -1)).toBe(true);
        expect(h.written.length).toBe(1);                      // no second temp file either

        h.respondHost("OK:Imported 1");
        expect(h.unlinked.length).toBe(1);
    });

    test("timeout: temp file cleaned and latch released even when AE never answers", () => {
        const h = buildHarness();
        h.PasteController.handlePasteBlob(imageBlob());
        h.clock.advance();                                     // write done, import in flight
        h.clock.advance();                                     // fire ToolBridge timeout
        expect(h.unlinked).toEqual([h.written[0].path]);       // cleanup on timeout
        expect(h.toasts.some((t) => t.message.indexOf("timed out") !== -1)).toBe(true);

        h.PasteController.handlePasteBlob(imageBlob());        // latch was released
        h.clock.advance();
        expect(h.hostCalls.length).toBe(2);
    });

    test("temp names are collision-safe across rapid pastes", () => {
        const h = buildHarness();
        h.PasteController.handlePasteBlob(imageBlob());
        h.clock.advance();
        h.respondHost("OK:1");
        h.PasteController.handlePasteBlob(imageBlob());
        h.clock.advance();
        h.respondHost("OK:2");

        expect(h.written.length).toBe(2);
        expect(h.written[0].path).not.toBe(h.written[1].path);
    });

    test("window paste: text-only clipboard is untouched; image accepts with preventDefault", () => {
        const h = buildHarness();
        h.initClipboardPaste();

        const textEvent = {
            clipboardData: { files: [], items: [{ type: "text/plain", getAsFile: function () { return { bytes: new Uint8Array([1]).buffer, type: "text/plain" }; } }] },
            preventDefault: jest.fn(),
        };
        h.listeners.window.paste(textEvent);
        expect(textEvent.preventDefault).not.toHaveBeenCalled();
        expect(h.hostCalls.length).toBe(0);

        const imageEvent = {
            clipboardData: {
                files: [],
                items: [{ type: "image/png", getAsFile: function () { return imageBlob(); } }],
            },
            preventDefault: jest.fn(),
        };
        h.listeners.window.paste(imageEvent);
        expect(imageEvent.preventDefault).toHaveBeenCalled();  // only after accepting the image
        h.clock.advance();
        expect(h.hostCalls.length).toBe(1);
    });

    test("initClipboardPaste is idempotent — one window listener", () => {
        const h = buildHarness();
        h.initClipboardPaste();
        h.initClipboardPaste();
        h.initClipboardPaste();
        expect(Object.keys(h.listeners.window)).toEqual(["paste"]);
    });

    test("handleImagePaste (clipboard button path) is bounded and single-flight", () => {
        const h = buildHarness();
        const button = { disabled: false, attrs: {}, setAttribute: function (k, v) { this.attrs[k] = v; }, removeAttribute: function (k) { delete this.attrs[k]; } };
        h.PasteController.handleImagePaste(button);
        h.PasteController.handleImagePaste(button); // rapid double-click
        expect(h.hostCalls.length).toBe(1);                  // exactly one host clipboard grab
        expect(button.disabled).toBe(true);

        h.respondHost("OK:Pasted");
        expect(button.disabled).toBe(false);
        expect(h.toasts.some((t) => t.kind === "success")).toBe(true);
    });
});
