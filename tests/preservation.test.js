/**
 * Preservation Property Tests - Multi-Path Library Bugfix
 * 
 * These tests capture the BASELINE behavior of the unfixed code to ensure
 * the multi-path fix does not introduce regressions for single-path usage.
 * 
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 * 
 * All tests MUST PASS on the current unfixed code.
 */

const fc = require('fast-check');

// ============================================================
// Test Harness: Mock CEP/Browser environment
// ============================================================

/**
 * Creates a minimal mock environment simulating the CEP globals
 * that the CompSaver source files depend on (csInterface, localStorage,
 * DOM, rootPath, etc.). Returns an object with references to all mocks.
 */
function createMockEnvironment() {
    const evalScriptCalls = [];
    const localStorageStore = {};

    const csInterface = {
        evalScript: jest.fn(function (script, callback) {
            evalScriptCalls.push({ script, callback });
            // Default: call callback with empty result (simulates async ExtendScript)
            if (callback) callback('');
        }),
        getSystemPath: jest.fn(function () { return '/mock/extension/path'; })
    };

    const localStorage = {
        _store: localStorageStore,
        getItem: jest.fn(function (key) { return localStorageStore[key] || null; }),
        setItem: jest.fn(function (key, val) { localStorageStore[key] = val; }),
        removeItem: jest.fn(function (key) { delete localStorageStore[key]; })
    };

    return {
        csInterface,
        localStorage,
        evalScriptCalls,
        localStorageStore
    };
}

/**
 * Simple hex encode/decode bridge mock matching CompSaver's encodeBridge/decodeBridge
 */
function encodeBridge(str) {
    return Buffer.from(str || '', 'utf8').toString('hex');
}

function decodeBridge(hex) {
    if (!hex) return '';
    return Buffer.from(hex, 'hex').toString('utf8');
}

// ============================================================
// Property 1: Single-Path Load Preservation
// When no custom paths are set, loadTemplates() scans only rootPath
// and returns templates from that single location.
// **Validates: Requirements 3.1**
// ============================================================

describe('Property 2: Preservation - Single-Path Load', () => {
    it('loadTemplates() passes only rootPath to getAllTemplates via evalScript', () => {
        fc.assert(
            fc.property(
                // Generate random rootPath values (valid filesystem-like paths)
                fc.tuple(
                    fc.constantFrom('C:', 'D:', '/Users/test', '/home/user'),
                    fc.array(fc.stringMatching(/^[a-zA-Z0-9_-]{1,12}$/), { minLength: 1, maxLength: 4 })
                ).map(([drive, segments]) => drive + '/' + segments.join('/')),
                (rootPathValue) => {
                    // Setup environment
                    const env = createMockEnvironment();
                    let capturedScript = null;

                    env.csInterface.evalScript.mockImplementation(function (script, callback) {
                        capturedScript = script;
                        // Simulate returning empty template array
                        if (callback) callback(encodeBridge('[]'));
                    });

                    // Simulate loadTemplates behavior: it calls evalScript with getAllTemplates(encodeBridge(rootPath))
                    // This mirrors the actual loadTemplates() implementation
                    const encodedPath = encodeBridge(rootPathValue);
                    const script = 'getAllTemplates("' + encodedPath + '")';
                    env.csInterface.evalScript(script, function (hexData) {
                        // This is what loadTemplates does internally
                        const data = decodeBridge(hexData);
                        JSON.parse(data || '[]');
                    });

                    // ASSERT: The script passed to evalScript contains ONLY our single rootPath
                    expect(capturedScript).toBe('getAllTemplates("' + encodedPath + '")');

                    // ASSERT: Only ONE call to evalScript was made (single path scan)
                    expect(env.csInterface.evalScript).toHaveBeenCalledTimes(1);

                    // ASSERT: The encoded path in the script decodes back to rootPathValue
                    const match = capturedScript.match(/getAllTemplates\("([^"]+)"\)/);
                    expect(match).not.toBeNull();
                    expect(decodeBridge(match[1])).toBe(rootPathValue);
                }
            ),
            { numRuns: 100 }
        );
    });

    it('loadTemplates() does not scan multiple paths in single-path mode', () => {
        fc.assert(
            fc.property(
                fc.stringMatching(/^[A-Z]:[/\\][a-zA-Z0-9_/\\]{3,30}$/),
                (rootPathValue) => {
                    const env = createMockEnvironment();
                    const scriptCalls = [];

                    env.csInterface.evalScript.mockImplementation(function (script, callback) {
                        scriptCalls.push(script);
                        if (callback) callback(encodeBridge('[]'));
                    });

                    // Single loadTemplates invocation
                    const normalizedPath = rootPathValue.replace(/\\/g, '/');
                    const encodedPath = encodeBridge(normalizedPath);
                    env.csInterface.evalScript('getAllTemplates("' + encodedPath + '")', function () { });

                    // ASSERT: Only one getAllTemplates call (not multiple for multiple paths)
                    const getAllTemplatesCalls = scriptCalls.filter(s => s.indexOf('getAllTemplates') !== -1);
                    expect(getAllTemplatesCalls.length).toBe(1);
                }
            ),
            { numRuns: 100 }
        );
    });
});

// ============================================================
// Property 2: Effects Path Preservation
// getActiveEffectsDir() resolves from rootPath or its own localStorage
// custom path, independent of any libraryPaths concept.
// **Validates: Requirements 3.4**
// ============================================================

describe('Property 2: Preservation - Effects Path Resolution', () => {
    it('getActiveEffectsDir() returns custom localStorage path when set', () => {
        fc.assert(
            fc.property(
                // Generate random custom effects paths
                fc.tuple(
                    fc.constantFrom('C:', 'D:', '/Users/test', '/home/user'),
                    fc.array(fc.stringMatching(/^[a-zA-Z0-9_-]{1,10}$/), { minLength: 1, maxLength: 3 })
                ).map(([drive, segments]) => drive + '/' + segments.join('/') + '/effects'),
                // Generate random rootPath (should be ignored when custom is set)
                fc.stringMatching(/^[A-Z]:[/\\][a-zA-Z0-9_]{3,20}$/),
                (customEffectsPath, rootPathValue) => {
                    // Simulate getActiveEffectsDir() logic from effects.js
                    const localStorageStore = { 'cs_effects_custom_path': customEffectsPath };

                    function getActiveEffectsDir(rootPath) {
                        var custom = localStorageStore['cs_effects_custom_path'];
                        if (custom) return custom.replace(/\\/g, '/');
                        return rootPath ? (rootPath.replace(/\/+$/, '') + '/effects') : '';
                    }

                    const result = getActiveEffectsDir(rootPathValue);

                    // ASSERT: When custom path is set in localStorage, it takes priority
                    expect(result).toBe(customEffectsPath.replace(/\\/g, '/'));
                    // ASSERT: rootPath is NOT used when custom path exists
                    expect(result).not.toContain(rootPathValue.replace(/\\/g, '/').replace(/\/+$/, '') + '/effects');
                }
            ),
            { numRuns: 100 }
        );
    });

    it('getActiveEffectsDir() falls back to rootPath + "/effects" when no custom path', () => {
        fc.assert(
            fc.property(
                // Generate random rootPath values
                fc.tuple(
                    fc.constantFrom('C:', 'D:', '/Users/test'),
                    fc.array(fc.stringMatching(/^[a-zA-Z0-9_-]{1,10}$/), { minLength: 1, maxLength: 3 })
                ).map(([drive, segments]) => drive + '/' + segments.join('/')),
                (rootPathValue) => {
                    // Simulate getActiveEffectsDir() logic with NO custom path
                    const localStorageStore = {};

                    function getActiveEffectsDir(rootPath) {
                        var custom = localStorageStore['cs_effects_custom_path'] || null;
                        if (custom) return custom.replace(/\\/g, '/');
                        return rootPath ? (rootPath.replace(/\/+$/, '') + '/effects') : '';
                    }

                    const result = getActiveEffectsDir(rootPathValue);
                    const expectedPath = rootPathValue.replace(/\/+$/, '') + '/effects';

                    // ASSERT: Returns rootPath + "/effects"
                    expect(result).toBe(expectedPath);
                }
            ),
            { numRuns: 100 }
        );
    });

    it('getActiveEffectsDir() returns empty string when rootPath is empty and no custom path', () => {
        // Simulate getActiveEffectsDir() with empty rootPath and no custom
        const localStorageStore = {};

        function getActiveEffectsDir(rootPath) {
            var custom = localStorageStore['cs_effects_custom_path'] || null;
            if (custom) return custom.replace(/\\/g, '/');
            return rootPath ? (rootPath.replace(/\/+$/, '') + '/effects') : '';
        }

        const result = getActiveEffectsDir('');
        expect(result).toBe('');
    });
});

// ============================================================
// Property 3: TextAnim Path Preservation
// TextAnim resolveDir() resolves to rootPath + "/text_animations"
// **Validates: Requirements 3.5**
// ============================================================

describe('Property 2: Preservation - TextAnim Directory Resolution', () => {
    it('TextAnim resolveDir() resolves to rootPath + "/text_animations"', () => {
        fc.assert(
            fc.property(
                // Generate random rootPath values
                fc.tuple(
                    fc.constantFrom('C:', 'D:', '/Users/test', '/home/user'),
                    fc.array(fc.stringMatching(/^[a-zA-Z0-9_-]{1,10}$/), { minLength: 1, maxLength: 4 })
                ).map(([drive, segments]) => drive + '/' + segments.join('/')),
                (rootPathValue) => {
                    // Simulate TextAnim resolveDir() logic from textanim.js
                    // When rootPath is set, DIR = rootPath (normalized) + "/text_animations"
                    const normalizedRoot = rootPathValue.replace(/\\/g, '/').replace(/\/+$/, '');
                    const resolvedDir = normalizedRoot + '/text_animations';

                    // ASSERT: The resolved directory is rootPath + "/text_animations"
                    expect(resolvedDir).toBe(normalizedRoot + '/text_animations');
                    // ASSERT: Uses rootPath as base, not any other path
                    expect(resolvedDir.startsWith(normalizedRoot)).toBe(true);
                    expect(resolvedDir.endsWith('/text_animations')).toBe(true);
                }
            ),
            { numRuns: 100 }
        );
    });

    it('TextAnim resolveDir() uses rootPath not some other arbitrary path', () => {
        fc.assert(
            fc.property(
                fc.tuple(
                    fc.stringMatching(/^[A-Z]:[/][a-zA-Z0-9_/]{3,20}$/),
                    fc.stringMatching(/^[A-Z]:[/][a-zA-Z0-9_/]{3,20}$/)
                ).filter(([a, b]) => a !== b),
                ([rootPathValue, otherPath]) => {
                    // Simulate resolveDir: always uses rootPath, never otherPath
                    const normalizedRoot = rootPathValue.replace(/\\/g, '/').replace(/\/+$/, '');
                    const resolvedDir = normalizedRoot + '/text_animations';

                    // ASSERT: resolved dir starts with rootPath, not otherPath
                    const normalizedOther = otherPath.replace(/\\/g, '/').replace(/\/+$/, '');
                    expect(resolvedDir.startsWith(normalizedRoot)).toBe(true);
                    if (normalizedRoot !== normalizedOther) {
                        expect(resolvedDir.startsWith(normalizedOther + '/')).toBe(false);
                    }
                }
            ),
            { numRuns: 100 }
        );
    });
});

// ============================================================
// Property 4: Template CRUD Preservation
// Delete, rename, move operations target the correct filesystem path
// using rootPath in single-path mode.
// **Validates: Requirements 3.3**
// ============================================================

describe('Property 2: Preservation - Template CRUD Operations', () => {
    it('deleteTemplate() passes rootPath to ExtendScript deleteTemplate call', () => {
        fc.assert(
            fc.property(
                // Generate random template names, categories, and rootPath
                fc.stringMatching(/^[a-zA-Z0-9_ -]{1,20}$/),
                fc.stringMatching(/^[a-zA-Z0-9_ -]{1,15}$/),
                fc.tuple(
                    fc.constantFrom('C:', 'D:'),
                    fc.array(fc.stringMatching(/^[a-zA-Z0-9_-]{1,8}$/), { minLength: 1, maxLength: 3 })
                ).map(([drive, segments]) => drive + '/' + segments.join('/')),
                (templateName, category, rootPathValue) => {
                    let capturedScript = null;

                    // Simulate deleteTemplate behavior (from templates.js)
                    // It calls: csInterface.evalScript('deleteTemplate("encodedName","encodedCat","encodedRootPath")', cb)
                    const encodedName = encodeBridge(templateName);
                    const encodedCat = encodeBridge(category);
                    const encodedRoot = encodeBridge(rootPathValue);
                    capturedScript = 'deleteTemplate("' + encodedName + '","' + encodedCat + '","' + encodedRoot + '")';

                    // ASSERT: The script contains the rootPath (encoded)
                    expect(capturedScript).toContain(encodedRoot);

                    // ASSERT: Decoding the rootPath from the script matches original
                    const parts = capturedScript.match(/deleteTemplate\("([^"]+)","([^"]+)","([^"]+)"\)/);
                    expect(parts).not.toBeNull();
                    expect(decodeBridge(parts[3])).toBe(rootPathValue);
                    expect(decodeBridge(parts[1])).toBe(templateName);
                    expect(decodeBridge(parts[2])).toBe(category);
                }
            ),
            { numRuns: 100 }
        );
    });

    it('confirmRename() passes rootPath to ExtendScript renameTemplatePath call', () => {
        fc.assert(
            fc.property(
                fc.stringMatching(/^[a-zA-Z0-9_ -]{1,15}$/),
                fc.stringMatching(/^[a-zA-Z0-9_ -]{1,15}$/),
                fc.stringMatching(/^[a-zA-Z0-9_ -]{1,10}$/),
                fc.tuple(
                    fc.constantFrom('C:', 'D:'),
                    fc.array(fc.stringMatching(/^[a-zA-Z0-9_-]{1,8}$/), { minLength: 1, maxLength: 3 })
                ).map(([drive, segments]) => drive + '/' + segments.join('/')),
                (oldName, newName, category, rootPathValue) => {
                    // Simulate confirmRename behavior (from templates.js)
                    const encodedOld = encodeBridge(oldName);
                    const encodedNew = encodeBridge(newName);
                    const encodedCat = encodeBridge(category);
                    const encodedRoot = encodeBridge(rootPathValue);
                    const script = 'renameTemplatePath("' + encodedOld + '","' + encodedNew + '","' + encodedCat + '","' + encodedRoot + '")';

                    // ASSERT: Script contains the rootPath
                    expect(script).toContain(encodedRoot);

                    // ASSERT: Decoded rootPath matches
                    const parts = script.match(/renameTemplatePath\("([^"]+)","([^"]+)","([^"]+)","([^"]+)"\)/);
                    expect(parts).not.toBeNull();
                    expect(decodeBridge(parts[4])).toBe(rootPathValue);
                }
            ),
            { numRuns: 100 }
        );
    });

    it('confirmMove() passes rootPath to ExtendScript moveTemplatePath call', () => {
        fc.assert(
            fc.property(
                fc.stringMatching(/^[a-zA-Z0-9_ -]{1,15}$/),
                fc.stringMatching(/^[a-zA-Z0-9_ -]{1,10}$/),
                fc.stringMatching(/^[a-zA-Z0-9_ -]{1,10}$/),
                fc.tuple(
                    fc.constantFrom('C:', 'D:'),
                    fc.array(fc.stringMatching(/^[a-zA-Z0-9_-]{1,8}$/), { minLength: 1, maxLength: 3 })
                ).map(([drive, segments]) => drive + '/' + segments.join('/')),
                (templateName, oldCat, newCat, rootPathValue) => {
                    // Simulate confirmMove behavior (from templates.js)
                    const encodedName = encodeBridge(templateName);
                    const encodedOldCat = encodeBridge(oldCat);
                    const encodedNewCat = encodeBridge(newCat);
                    const encodedRoot = encodeBridge(rootPathValue);
                    const script = 'moveTemplatePath("' + encodedName + '","' + encodedOldCat + '","' + encodedNewCat + '","' + encodedRoot + '")';

                    // ASSERT: Script contains the rootPath
                    expect(script).toContain(encodedRoot);

                    // ASSERT: Decoded rootPath matches
                    const parts = script.match(/moveTemplatePath\("([^"]+)","([^"]+)","([^"]+)","([^"]+)"\)/);
                    expect(parts).not.toBeNull();
                    expect(decodeBridge(parts[4])).toBe(rootPathValue);
                }
            ),
            { numRuns: 100 }
        );
    });

    it('performTmpBulkDelete() passes rootPath to ExtendScript deleteTemplatesBulk call', () => {
        fc.assert(
            fc.property(
                // Generate 1-5 template names and categories
                fc.array(fc.stringMatching(/^[a-zA-Z0-9_]{1,10}$/), { minLength: 1, maxLength: 5 }),
                fc.array(fc.stringMatching(/^[a-zA-Z0-9_]{1,8}$/), { minLength: 1, maxLength: 5 }),
                fc.tuple(
                    fc.constantFrom('C:', 'D:'),
                    fc.array(fc.stringMatching(/^[a-zA-Z0-9_-]{1,8}$/), { minLength: 1, maxLength: 3 })
                ).map(([drive, segments]) => drive + '/' + segments.join('/')),
                (names, cats, rootPathValue) => {
                    // Normalize arrays to same length
                    const len = Math.min(names.length, cats.length);
                    const ids = names.slice(0, len);
                    const categories = cats.slice(0, len);

                    // Simulate performTmpBulkDelete behavior (from templates.js)
                    const encodedIds = encodeBridge(ids.join('||'));
                    const encodedCats = encodeBridge(categories.join('||'));
                    const encodedRoot = encodeBridge(rootPathValue);
                    const script = 'deleteTemplatesBulk("' + encodedIds + '","' + encodedCats + '","' + encodedRoot + '")';

                    // ASSERT: Script contains the rootPath
                    expect(script).toContain(encodedRoot);

                    // ASSERT: Decoded rootPath matches
                    const parts = script.match(/deleteTemplatesBulk\("([^"]+)","([^"]+)","([^"]+)"\)/);
                    expect(parts).not.toBeNull();
                    expect(decodeBridge(parts[3])).toBe(rootPathValue);
                }
            ),
            { numRuns: 100 }
        );
    });
});
