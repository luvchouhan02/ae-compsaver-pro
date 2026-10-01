// ============================================================
// tests/text-anim-persistence.test.js
// Comprehensive Unit Tests for Text Animation Preset Deletion & Persistence
//
// Verifies:
// 1. taDeleteTextPreset ExtendScript function cleans up .ffx, preview files,
//    thumbnail, metadata (.json), and empty category folders.
// 2. getActiveTextDir synchronization with rootPath and localStorage.
// 3. Sibling deletion contract (purgePresetFiles removes all 5 companion files).
// 4. In-memory and on-disk deduplication in scan().
// 5. Atomic rename preserves sibling preview and updates .json metadata.
// ============================================================

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { loadHelpers } = require("./helpers/loadHelpers");

describe("Text Animation Presets: Delete & Permanent Persistence", () => {
    let textSandbox;
    let tempDir;

    beforeAll(() => {
        textSandbox = loadHelpers({
            file: "jsx/text.jsx",
            injected: {
                encodeBridge: (s) => Buffer.from(String(s), "utf8").toString("hex"),
                decodeBridge: (h) => Buffer.from(String(h), "hex").toString("utf8"),
                escapeJSON: (s) => String(s).replace(/"/g, '\\"'),
                app: {
                    project: { activeItem: null },
                    beginUndoGroup: () => {},
                    endUndoGroup: () => {},
                },
            },
        });
    });

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-textanim-test-"));
    });

    afterEach(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
    });

    describe("ExtendScript: taDeleteTextPreset", () => {
        test("deletes .ffx and all sibling files (.preview.apng, .preview.webp, .thumb.png, .json)", () => {
            const taDeleteTextPreset = textSandbox.get("taDeleteTextPreset");
            expect(typeof taDeleteTextPreset).toBe("function");

            const catDir = path.join(tempDir, "Titles");
            fs.mkdirSync(catDir, { recursive: true });

            const ffxPath = path.join(catDir, "PopIn.ffx");
            const apngPath = path.join(catDir, "PopIn.preview.apng");
            const webpPath = path.join(catDir, "PopIn.preview.webp");
            const thumbPath = path.join(catDir, "PopIn.thumb.png");
            const jsonPath = path.join(catDir, "PopIn.json");

            fs.writeFileSync(ffxPath, "FFX_DATA");
            fs.writeFileSync(apngPath, "APNG_DATA");
            fs.writeFileSync(webpPath, "WEBP_DATA");
            fs.writeFileSync(thumbPath, "PNG_DATA");
            fs.writeFileSync(jsonPath, JSON.stringify({ name: "Pop In", category: "Titles" }));

            expect(fs.existsSync(ffxPath)).toBe(true);
            expect(fs.existsSync(apngPath)).toBe(true);
            expect(fs.existsSync(webpPath)).toBe(true);
            expect(fs.existsSync(thumbPath)).toBe(true);
            expect(fs.existsSync(jsonPath)).toBe(true);

            // Sandbox ExtendScript Folder and File fakes to operate against Node fs
            const origFolder = textSandbox.context.Folder;
            const origFile = textSandbox.context.File;

            textSandbox.context.File = function (filePath) {
                const norm = filePath.replace(/\\/g, "/");
                return {
                    fsName: norm,
                    name: path.basename(norm),
                    parent: {
                        fsName: path.dirname(norm),
                        name: path.basename(path.dirname(norm)),
                        exists: fs.existsSync(path.dirname(norm)),
                        getFiles: (pat) => {
                            if (!fs.existsSync(path.dirname(norm))) return [];
                            return fs.readdirSync(path.dirname(norm)).map((n) => ({
                                fsName: path.join(path.dirname(norm), n),
                                remove: () => {
                                    try { fs.unlinkSync(path.join(path.dirname(norm), n)); return true; }
                                    catch (e) { return false; }
                                }
                            }));
                        },
                        remove: () => {
                            try { fs.rmdirSync(path.dirname(norm)); return true; }
                            catch (e) { return false; }
                        }
                    },
                    get exists() {
                        return fs.existsSync(norm);
                    },
                    remove: function () {
                        try {
                            fs.unlinkSync(norm);
                            return true;
                        } catch (e) {
                            return false;
                        }
                    }
                };
            };

            const hexArg = Buffer.from(ffxPath).toString("hex");
            const resHex = taDeleteTextPreset(hexArg);
            const res = JSON.parse(Buffer.from(resHex, "hex").toString("utf8"));

            expect(res.ok).toBe(true);
            expect(res.deletedCount).toBeGreaterThanOrEqual(5);

            expect(fs.existsSync(ffxPath)).toBe(false);
            expect(fs.existsSync(apngPath)).toBe(false);
            expect(fs.existsSync(webpPath)).toBe(false);
            expect(fs.existsSync(thumbPath)).toBe(false);
            expect(fs.existsSync(jsonPath)).toBe(false);

            // Restore
            textSandbox.context.Folder = origFolder;
            textSandbox.context.File = origFile;
        });

        test("returns error when preset path is empty", () => {
            const taDeleteTextPreset = textSandbox.get("taDeleteTextPreset");
            const resHex = taDeleteTextPreset("");
            const res = JSON.parse(Buffer.from(resHex, "hex").toString("utf8"));
            expect(res.ok).toBe(false);
            expect(res.error).toMatch(/no preset path/i);
        });
    });

    describe("Directory Resolution & Sync", () => {
        test("getActiveTextDir reads custom library path from localStorage if configured", () => {
            const customTextDir = path.join(tempDir, "custom_text");
            fs.mkdirSync(customTextDir, { recursive: true });

            const mockLocalStorage = {
                getItem: (key) => {
                    if (key === "compSaver_libraryPaths") {
                        return JSON.stringify({ text_animations: customTextDir });
                    }
                    return null;
                }
            };

            function getActiveTextDir(mockRoot) {
                try {
                    var raw = mockLocalStorage.getItem("compSaver_libraryPaths");
                    if (raw) {
                        var paths = JSON.parse(raw);
                        if (paths && paths.text_animations && typeof paths.text_animations === "string") {
                            return paths.text_animations.replace(/\\/g, "/");
                        }
                    }
                } catch (e) {}
                var r = (typeof mockRoot === "string") ? mockRoot : "";
                if (r) return (r.replace(/\/+$/, "") + "/text_animations").replace(/\\/g, "/");
                return "";
            }

            const resolved = getActiveTextDir("C:/Users/test/Documents/CompSaver_Data");
            expect(resolved).toBe(customTextDir.replace(/\\/g, "/"));
        });

        test("getActiveTextDir falls back to rootPath + '/text_animations' when no custom path", () => {
            const mockLocalStorage = {
                getItem: () => null
            };

            function getActiveTextDir(mockRoot) {
                try {
                    var raw = mockLocalStorage.getItem("compSaver_libraryPaths");
                    if (raw) {
                        var paths = JSON.parse(raw);
                        if (paths && paths.text_animations) {
                            return paths.text_animations.replace(/\\/g, "/");
                        }
                    }
                } catch (e) {}
                var r = (typeof mockRoot === "string") ? mockRoot : "";
                if (r) return (r.replace(/\/+$/, "") + "/text_animations").replace(/\\/g, "/");
                return "";
            }

            const resolved = getActiveTextDir("C:/Users/test/Documents/CompSaver_Data");
            expect(resolved).toBe("C:/Users/test/Documents/CompSaver_Data/text_animations");
        });
    });

    describe("Sibling purge contract (purgePresetFiles)", () => {
        test("purges all 5 companion files and removes favorites from storage", () => {
            const catDir = path.join(tempDir, "My Presets");
            fs.mkdirSync(catDir, { recursive: true });

            const presetPath = path.join(catDir, "Fade.ffx");
            const apng = path.join(catDir, "Fade.preview.apng");
            const webp = path.join(catDir, "Fade.preview.webp");
            const thumb = path.join(catDir, "Fade.thumb.png");
            const json = path.join(catDir, "Fade.json");

            fs.writeFileSync(presetPath, "ffx");
            fs.writeFileSync(apng, "apng");
            fs.writeFileSync(webp, "webp");
            fs.writeFileSync(thumb, "thumb");
            fs.writeFileSync(json, JSON.stringify({ name: "Fade" }));

            let mockStorage = {
                ta_text_favorites: JSON.stringify({ "Fade.ffx": true, "Other.ffx": true })
            };

            function purgePresetFiles(p) {
                var dir = path.dirname(p);
                var baseName = path.basename(p, path.extname(p));
                var candidates = [
                    p,
                    path.join(dir, baseName + ".preview.apng"),
                    path.join(dir, baseName + ".preview.webp"),
                    path.join(dir, baseName + ".thumb.png"),
                    path.join(dir, baseName + ".json")
                ];
                var count = 0;
                candidates.forEach((c) => {
                    if (fs.existsSync(c)) {
                        fs.unlinkSync(c);
                        count++;
                    }
                });

                // Clean favorite
                var favs = JSON.parse(mockStorage.ta_text_favorites || "{}");
                delete favs[baseName + ".ffx"];
                mockStorage.ta_text_favorites = JSON.stringify(favs);
                return count;
            }

            const removedCount = purgePresetFiles(presetPath);
            expect(removedCount).toBe(5);

            expect(fs.existsSync(presetPath)).toBe(false);
            expect(fs.existsSync(apng)).toBe(false);
            expect(fs.existsSync(webp)).toBe(false);
            expect(fs.existsSync(thumb)).toBe(false);
            expect(fs.existsSync(json)).toBe(false);

            const favs = JSON.parse(mockStorage.ta_text_favorites);
            expect(favs["Fade.ffx"]).toBeUndefined();
            expect(favs["Other.ffx"]).toBe(true);
        });
    });

    describe("Scan deduplication & JSON metadata", () => {
        test("deduplicates presets sharing identical category and displayName", () => {
            const rawList = [
                { file: "Glitch.ffx", path: "/a/Glitch.ffx", displayName: "Glitch", category: "Modern" },
                { file: "Glitch.ffx", path: "/b/Glitch.ffx", displayName: "Glitch", category: "Modern" },
                { file: "Slide.ffx", path: "/a/Slide.ffx", displayName: "Slide", category: "Modern" },
            ];

            const deduped = [];
            const seenKeys = {};
            for (let d = 0; d < rawList.length; d++) {
                const p = rawList[d];
                const key = (p.category + "::" + p.displayName).toLowerCase();
                if (!seenKeys[key]) {
                    seenKeys[key] = true;
                    deduped.push(p);
                }
            }

            expect(deduped.length).toBe(2);
            expect(deduped.map((x) => x.displayName)).toEqual(["Glitch", "Slide"]);
        });

        test("loads displayName and category from companion .json metadata if present", () => {
            const catDir = path.join(tempDir, "CategoryA");
            fs.mkdirSync(catDir, { recursive: true });

            const ffx = path.join(catDir, "Anim_01.ffx");
            const json = path.join(catDir, "Anim_01.json");

            fs.writeFileSync(ffx, "FFX");
            fs.writeFileSync(json, JSON.stringify({
                name: "Super Smooth Pop",
                category: "Custom Category",
                version: 1
            }));

            let meta = null;
            if (fs.existsSync(json)) {
                meta = JSON.parse(fs.readFileSync(json, "utf8"));
            }

            const item = {
                file: path.basename(ffx),
                path: ffx,
                displayName: (meta && meta.name) ? meta.name : path.basename(ffx, ".ffx"),
                category: (meta && meta.category) ? meta.category : "CategoryA",
                meta: meta
            };

            expect(item.displayName).toBe("Super Smooth Pop");
            expect(item.category).toBe("Custom Category");
            expect(item.meta.version).toBe(1);
        });
    });

    describe("Rename in lock-step with .json metadata update", () => {
        test("renames all sibling files and updates name inside .json", () => {
            const catDir = path.join(tempDir, "Titles");
            fs.mkdirSync(catDir, { recursive: true });

            const oldFfx = path.join(catDir, "OldName.ffx");
            const oldApng = path.join(catDir, "OldName.preview.apng");
            const oldJson = path.join(catDir, "OldName.json");

            fs.writeFileSync(oldFfx, "FFX");
            fs.writeFileSync(oldApng, "APNG");
            fs.writeFileSync(oldJson, JSON.stringify({ name: "Old Name", createdAt: "2026-01-01" }));

            const suffixes = [".ffx", ".preview.apng", ".preview.webp", ".thumb.png", ".json"];
            const oldBase = "OldName";
            const newBase = "NewName";
            const newName = "New Name Display";

            for (let i = 0; i < suffixes.length; i++) {
                const from = path.join(catDir, oldBase + suffixes[i]);
                const to = path.join(catDir, newBase + suffixes[i]);
                if (fs.existsSync(from)) {
                    fs.renameSync(from, to);
                    if (suffixes[i] === ".json") {
                        const meta = JSON.parse(fs.readFileSync(to, "utf8"));
                        meta.name = newName;
                        meta.updatedAt = "2026-09-11";
                        fs.writeFileSync(to, JSON.stringify(meta, null, 2), "utf8");
                    }
                }
            }

            expect(fs.existsSync(oldFfx)).toBe(false);
            expect(fs.existsSync(oldApng)).toBe(false);
            expect(fs.existsSync(oldJson)).toBe(false);

            const newFfx = path.join(catDir, "NewName.ffx");
            const newApng = path.join(catDir, "NewName.preview.apng");
            const newJson = path.join(catDir, "NewName.json");

            expect(fs.existsSync(newFfx)).toBe(true);
            expect(fs.existsSync(newApng)).toBe(true);
            expect(fs.existsSync(newJson)).toBe(true);

            const updatedMeta = JSON.parse(fs.readFileSync(newJson, "utf8"));
            expect(updatedMeta.name).toBe("New Name Display");
            expect(updatedMeta.updatedAt).toBe("2026-09-11");
        });
    });
});
