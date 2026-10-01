"use strict";

const ThumbnailEngine = require("../js/core/thumbnailEngine");

describe("ThumbnailEngine", () => {
    afterEach(() => {
        ThumbnailEngine.clear();
    });

    test("exports expected API methods", () => {
        expect(typeof ThumbnailEngine.enqueue).toBe("function");
        expect(typeof ThumbnailEngine.runOne).toBe("function");
        expect(typeof ThumbnailEngine.isBusy).toBe("function");
        expect(typeof ThumbnailEngine.queueLength).toBe("function");
        expect(typeof ThumbnailEngine.clear).toBe("function");
    });

    test("rejects empty aepPath or outPngPath immediately", (done) => {
        let count = 0;
        ThumbnailEngine.enqueue(null, "/out.png", (err) => {
            expect(err).toBe("no path");
            count++;
            ThumbnailEngine.enqueue("/aep.aep", "", (err2) => {
                expect(err2).toBe("no path");
                count++;
                expect(count).toBe(2);
                expect(ThumbnailEngine.queueLength()).toBe(0);
                done();
            });
        });
    });

    test("delegates to TextAnim.enqueueThumbnailRender when TextAnim is present", (done) => {
        const calls = [];
        global.TextAnim = {
            enqueueThumbnailRender: function (aep, out, cb, comp, frame) {
                calls.push({ aep, out, comp, frame });
                if (cb) cb(null);
            }
        };

        ThumbnailEngine.enqueue("/test/project.aep", "/test/thumbnail.png", (err) => {
            expect(err).toBeNull();
            expect(calls).toHaveLength(1);
            expect(calls[0].aep).toBe("/test/project.aep");
            expect(calls[0].out).toBe("/test/thumbnail.png");
            delete global.TextAnim;
            done();
        }, "Comp 1", 15);
    });

    test("runOne uses AerenderRunner when available and compName is supplied", (done) => {
        const aerenderCalls = [];
        global.AerenderRunner = {
            renderThumbnail: function (options, cb) {
                aerenderCalls.push(options);
                cb({ ok: true, durationMs: 50 });
            }
        };

        const job = {
            aepPath: "/proj/test.aep",
            outPngPath: "/proj/thumbnail.png",
            compName: "MainComp",
            renderFrame: 10
        };

        ThumbnailEngine.runOne(job, (err) => {
            expect(err).toBeNull();
            expect(aerenderCalls).toHaveLength(1);
            expect(aerenderCalls[0].compName).toBe("MainComp");
            expect(aerenderCalls[0].frame).toBe(10);
            delete global.AerenderRunner;
            done();
        });
    });

    test("runOne falls back to host bridge when AerenderRunner fails", (done) => {
        global.AerenderRunner = {
            renderThumbnail: function (options, cb) {
                cb({ ok: false, error: "CLI not found" });
            }
        };

        const evalCalls = [];
        global.csInterface = {
            evalScript: function (script, cb) {
                evalCalls.push(script);
                cb(JSON.stringify({ ok: true }));
            }
        };

        const job = {
            aepPath: "/proj/test.aep",
            outPngPath: "/proj/thumbnail.png",
            compName: "MainComp",
            renderFrame: 0
        };

        ThumbnailEngine.runOne(job, (err) => {
            expect(err).toBeNull();
            expect(evalCalls).toHaveLength(1);
            expect(evalCalls[0]).toContain("renderTemplateThumbnail");
            delete global.AerenderRunner;
            delete global.csInterface;
            done();
        });
    });

    test("runOne handles in-project host failure gracefully", (done) => {
        global.csInterface = {
            evalScript: function (script, cb) {
                cb(JSON.stringify({ ok: false, error: "AE render failed" }));
            }
        };

        const job = {
            aepPath: "/proj/test.aep",
            outPngPath: "/proj/thumbnail.png"
        };

        ThumbnailEngine.runOne(job, (err) => {
            expect(err).toMatch(/AE thumbnail: AE render failed/);
            delete global.csInterface;
            done();
        });
    });
});
