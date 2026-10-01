// ============================================================
// tests/text-anim-preset.test.js
// Unit tests for CompSaver Text Animation Preset engine fixes.
//
// Validates:
// 1. isTextLayer(layer) infallible text layer recognition.
// 2. selectTextAnimationProperties(layer) selective property bundling:
//    - Selects animators, more options, path options
//    - Selects dependent effects (Slider Controls, Checkboxes, etc.)
//    - Selects animated transforms
//    - Strictly OMITS ADBE Text Document (Source Text) and ADBE Text Properties
// 3. User Text Preservation: Target layer TextDocument remains intact.
// ============================================================

"use strict";

const { loadHelpers } = require("./helpers/loadHelpers");

describe("Text Animation Preset Engine Fixes", () => {
    let coreSandbox;
    let textSandbox;

    beforeAll(() => {
        coreSandbox = loadHelpers({ file: "jsx/core.jsx" });
        textSandbox = loadHelpers({
            file: "jsx/text.jsx",
            globals: {
                encodeBridge: (s) => Buffer.from(String(s), "utf8").toString("hex"),
                decodeBridge: (h) => Buffer.from(String(h), "hex").toString("utf8"),
                app: {
                    project: {
                        activeItem: null,
                        bitsPerChannel: 8,
                    },
                    beginUndoGroup: () => {},
                    endUndoGroup: () => {},
                    beginSuppressDialogs: () => {},
                    endSuppressDialogs: () => {},
                },
                CompItem: function () {},
                Folder: function (p) {
                    return { fsName: p, exists: true };
                },
                File: function (p) {
                    return { fsName: p, exists: true };
                },
            },
        });
    });

    describe("isTextLayer infallible detection", () => {
        test("identifies layer with matchName === 'ADBE Text Layer'", () => {
            const isTextLayer = coreSandbox.get("isTextLayer");
            expect(typeof isTextLayer).toBe("function");

            const layer = { matchName: "ADBE Text Layer" };
            expect(isTextLayer(layer)).toBe(true);
        });

        test("identifies layer with ADBE Text Properties present", () => {
            const isTextLayer = coreSandbox.get("isTextLayer");
            const layer = {
                matchName: "ADBE AVLayer",
                property: (name) => (name === "ADBE Text Properties" ? {} : null),
            };
            expect(isTextLayer(layer)).toBe(true);
        });

        test("rejects null, undefined, camera, light, or shape layers without text properties", () => {
            const isTextLayer = coreSandbox.get("isTextLayer");
            expect(isTextLayer(null)).toBe(false);
            expect(isTextLayer(undefined)).toBe(false);

            const camLayer = { matchName: "ADBE Camera Layer", property: () => null };
            expect(isTextLayer(camLayer)).toBe(false);

            const shapeLayer = { matchName: "ADBE Vector Layer", property: () => null };
            expect(isTextLayer(shapeLayer)).toBe(false);

            const solidLayer = { matchName: "ADBE AVLayer", property: () => null };
            expect(isTextLayer(solidLayer)).toBe(false);
        });
    });

    describe("selectTextAnimationProperties selective selection", () => {
        test("bundles animators, effects, and transforms but strictly excludes ADBE Text Document", () => {
            const selectProps = textSandbox.get("selectTextAnimationProperties");
            expect(typeof selectProps).toBe("function");

            // Mock animators
            const animator1 = { name: "Animator 1", selected: false };
            const animator2 = { name: "Animator 2", selected: false };
            const animatorsGroup = {
                matchName: "ADBE Text Animators",
                numProperties: 2,
                property: (i) => (i === 1 ? animator1 : i === 2 ? animator2 : null),
            };

            // Mock source text and text properties parent
            const sourceTextProp = { matchName: "ADBE Text Document", selected: false };
            const moreOptionsProp = { matchName: "ADBE Text More Options", selected: false };
            const pathOptionsProp = { matchName: "ADBE Text Path Options", selected: false };

            const textPropsGroup = {
                matchName: "ADBE Text Properties",
                selected: false,
                property: (name) => {
                    if (name === "ADBE Text Animators") return animatorsGroup;
                    if (name === "ADBE Text Document") return sourceTextProp;
                    if (name === "ADBE Text More Options") return moreOptionsProp;
                    if (name === "ADBE Text Path Options") return pathOptionsProp;
                    return null;
                },
            };

            // Mock effect parade (Slider Control used by expression)
            const sliderEffect = { name: "Slider Control", matchName: "ADBE Slider Control", selected: false };
            const effectsGroup = {
                matchName: "ADBE Effect Parade",
                numProperties: 1,
                property: (i) => (i === 1 ? sliderEffect : null),
            };

            // Mock transform group (Position animated with keyframes)
            const posProp = { name: "Position", numKeys: 2, selected: false };
            const scaleProp = { name: "Scale", numKeys: 0, selected: false };
            const transformGroup = {
                matchName: "ADBE Transform Group",
                numProperties: 2,
                property: (i) => (i === 1 ? posProp : i === 2 ? scaleProp : null),
            };

            const mockLayer = {
                matchName: "ADBE Text Layer",
                selectedProperties: [],
                property: (name) => {
                    if (name === "ADBE Text Properties") return textPropsGroup;
                    if (name === "ADBE Effect Parade") return effectsGroup;
                    if (name === "ADBE Transform Group") return transformGroup;
                    return null;
                },
            };

            const count = selectProps(mockLayer);

            // Assertions:
            // 1. Animators are selected
            expect(animator1.selected).toBe(true);
            expect(animator2.selected).toBe(true);

            // 2. More Options is selected
            expect(moreOptionsProp.selected).toBe(true);

            // 3. Effects (Slider Control) are selected
            expect(sliderEffect.selected).toBe(true);

            // 4. Animated transforms are selected
            expect(posProp.selected).toBe(true);
            expect(scaleProp.selected).toBe(false); // non-animated not selected

            // 5. CRITICAL: Source Text and parent Text Properties MUST NOT be selected!
            expect(sourceTextProp.selected).toBe(false);
            expect(textPropsGroup.selected).toBe(false);

            expect(count.length).toBeGreaterThanOrEqual(4);
        });
    });

    describe("classifyLayer in core.jsx", () => {
        test("correctly returns 'text' for AVLayer matching text layer properties", () => {
            const classifyLayer = coreSandbox.get("classifyLayer");
            expect(typeof classifyLayer).toBe("function");

            const textAvLayer = {
                matchName: "ADBE Text Layer",
                property: (name) => (name === "ADBE Text Properties" ? {} : null),
            };
            expect(classifyLayer(textAvLayer)).toBe("text");
        });
    });
});
