// ============================================================
// core/settings.js — centralized settings manager
// ------------------------------------------------------------
// Global Settings IIFE providing get/set with validation,
// persistence, change notification, migration, and export/import.
// Must load AFTER constants.js + state.js, BEFORE all other modules.
// All modules read settings via Settings.get("dot.key").
// ============================================================

var Settings = (function () {

    // ── Default Values ─────────────────────────────────────────────
    var _defaults = {
        library: {
            saveTo: "default",
            confirmOverwrite: true
        },
        preview: {
            autoGenerate: true,
            quality: "medium",
            maxDuration: 4,
            showNotifications: true,
            disableHover: false
        },
        ui: {
            defaultTab: "toolkit",
            defaultSection: "comp",
            density: "compact",

            iconCardSize: "small",
            templateCardSize: "small",
            textAnimCardSize: "small",
            confirmDelete: true,
            showAllCategoriesInline: true,
            pinnedCategories: []
        },
        performance: {
            searchDebounce: 150,
            liveFolderWatch: true,
            pingInterval: 30,
            effectsScanTtlMs: 4000,
            isolatedAerender: true
        },
        toolkit: {
            quietRapidTools: false,
            sequencerStep: 5,
            sequencerMode: "down",
            colorflowDefaultPalette: "",
            colorflowTarget: "fill"
        },
        appearance: {
            accent: "blue",
            accentCustom: "#4f8cff"
        }
    };

    // ── Validation Schema ──────────────────────────────────────────
    var _schema = {
        "library.saveTo": { type: "enum", values: ["default", "custom", "ask"] },
        "library.confirmOverwrite": { type: "boolean" },
        "preview.autoGenerate": { type: "boolean" },
        "preview.quality": { type: "enum", values: ["low", "medium", "high"] },
        "preview.maxDuration": { type: "number", min: 1, max: 30 },
        "preview.showNotifications": { type: "boolean" },
        "preview.disableHover": { type: "boolean" },
        "ui.defaultTab": { type: "enum", values: ["templates", "toolkit"] },
        "ui.defaultSection": { type: "enum", values: ["comp", "icon", "overlay", "layer", "text", "footage", "effect"] },
        "ui.density": { type: "enum", values: ["compact", "expanded"] },

        "ui.iconCardSize": { type: "enum", values: ["small", "medium", "large"] },
        "ui.templateCardSize": { type: "enum", values: ["small", "medium", "large"] },
        "ui.textAnimCardSize": { type: "enum", values: ["small", "medium", "large"] },
        "ui.confirmDelete": { type: "boolean" },
        "ui.showAllCategoriesInline": { type: "boolean" },
        "ui.pinnedCategories": { type: "array" },
        "performance.searchDebounce": { type: "number", min: 50, max: 500 },
        "performance.liveFolderWatch": { type: "boolean" },
        "performance.pingInterval": { type: "number", min: 5, max: 120 },
        "performance.effectsScanTtlMs": { type: "number", min: 0, max: 60000 },
        "performance.isolatedAerender": { type: "boolean" },
        "toolkit.quietRapidTools": { type: "boolean" },
        "toolkit.sequencerStep": { type: "number", min: 1, max: 100 },
        "toolkit.sequencerMode": { type: "enum", values: ["down", "up", "random", "from_center", "to_center"] },
        "toolkit.colorflowDefaultPalette": { type: "string" },
        "toolkit.colorflowTarget": { type: "enum", values: ["fill", "stroke", "both"] },
        "appearance.accent": { type: "enum", values: ["blue", "violet", "teal", "green", "amber", "rose", "custom"] },
        "appearance.accentCustom": { type: "string" }
    };

    // ── Legacy Migration Map ───────────────────────────────────────
    var _migrationMap = {
        "compSaver_libraryPaths": "library.paths",
        "compSaver_pinnedCategories": "ui.pinnedCategories",
        "compSaver_showAllInline": "ui.showAllCategoriesInline",
        "cs_colorflow_target": "toolkit.colorflowTarget",
        "cs_colorflow_default_palette_name": "toolkit.colorflowDefaultPalette"
    };

    // ── Private State ──────────────────────────────────────────────
    var _data = {};
    var _listeners = {};

    // ── Helper Functions ───────────────────────────────────────────

    function _deepCopy(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    function _getByPath(obj, dotKey) {
        var parts = dotKey.split(".");
        var current = obj;
        for (var i = 0; i < parts.length; i++) {
            if (current === null || current === undefined || typeof current !== "object") {
                return undefined;
            }
            current = current[parts[i]];
        }
        return current;
    }

    function _setByPath(obj, dotKey, value) {
        var parts = dotKey.split(".");
        var current = obj;
        for (var i = 0; i < parts.length - 1; i++) {
            if (current[parts[i]] === undefined || current[parts[i]] === null || typeof current[parts[i]] !== "object") {
                current[parts[i]] = {};
            }
            current = current[parts[i]];
        }
        current[parts[parts.length - 1]] = value;
    }

    function _validate(key, value) {
        var rule = _schema[key];
        if (!rule) {
            return false;
        }

        switch (rule.type) {
            case "boolean":
                return typeof value === "boolean";
            case "string":
                return typeof value === "string";
            case "number":
                if (typeof value !== "number" || isNaN(value)) return false;
                if (rule.min !== undefined && value < rule.min) return false;
                if (rule.max !== undefined && value > rule.max) return false;
                return true;
            case "enum":
                return rule.values.indexOf(value) !== -1;
            case "array":
                return Array.isArray(value);
            default:
                return false;
        }
    }

    function _persist() {
        try {
            localStorage.setItem("compSaver_settings", JSON.stringify(_data));
        } catch (e) {
            // localStorage quota exceeded or unavailable
            try {
                if (typeof showToast === "function") {
                    showToast("Settings could not be saved — storage full", "error");
                }
            } catch (ignore) { }
            if (typeof console !== "undefined" && console.warn) {
                console.warn("[Settings] Persist failed:", e);
            }
        }
    }

    function _fireListeners(key, newVal, oldVal) {
        var cbs = _listeners[key];
        if (!cbs || !cbs.length) return;
        for (var i = 0; i < cbs.length; i++) {
            try {
                cbs[i](newVal, oldVal);
            } catch (e) {
                if (typeof console !== "undefined" && console.warn) {
                    console.warn("[Settings] onChange listener error for key '" + key + "':", e);
                }
            }
        }
    }

    function _migrate() {
        var migrated = {};
        for (var legacyKey in _migrationMap) {
            if (!_migrationMap.hasOwnProperty(legacyKey)) continue;
            var newKey = _migrationMap[legacyKey];
            var raw = null;
            try {
                raw = localStorage.getItem(legacyKey);
            } catch (e) {
                continue;
            }
            if (raw === null) continue;

            // Try JSON.parse first, fall back to raw string
            var parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                parsed = raw;
            }

            _setByPath(migrated, newKey, parsed);
        }
        return migrated;
    }

    function _mergeDeep(target, source) {
        for (var key in source) {
            if (!source.hasOwnProperty(key)) continue;
            if (
                source[key] !== null &&
                typeof source[key] === "object" &&
                !Array.isArray(source[key]) &&
                target[key] !== null &&
                typeof target[key] === "object" &&
                !Array.isArray(target[key])
            ) {
                _mergeDeep(target[key], source[key]);
            } else {
                target[key] = source[key];
            }
        }
        return target;
    }

    // ── Initialization ─────────────────────────────────────────────
    (function _init() {
        var stored = null;
        try {
            stored = localStorage.getItem("compSaver_settings");
        } catch (e) {
            // localStorage unavailable — in-memory only
            if (typeof console !== "undefined" && console.warn) {
                console.warn("[Settings] localStorage unavailable, running in-memory only.");
            }
        }

        if (stored === null) {
            // First load — migrate legacy keys
            _data = _deepCopy(_defaults);
            var migrated = _migrate();
            _mergeDeep(_data, migrated);
            _persist();
        } else {
            // Existing blob — parse and merge over defaults
            try {
                var parsed = JSON.parse(stored);
                _data = _deepCopy(_defaults);
                _mergeDeep(_data, parsed);
            } catch (e) {
                // Corrupted JSON — fall back to defaults
                _data = _deepCopy(_defaults);
                // Schedule error toast on next tick
                setTimeout(function () {
                    try {
                        if (typeof showToast === "function") {
                            showToast("Settings data was corrupted and has been reset to defaults.", "error");
                        }
                    } catch (ignore) { }
                }, 0);
                if (typeof console !== "undefined" && console.warn) {
                    console.warn("[Settings] compSaver_settings corrupted, using defaults.");
                }
                _persist();
            }
        }

        // ── One-time migration: default launch tab Templates -> Toolkit ──
        // The product default changed from "templates" to "toolkit". Existing
        // installs have "templates" persisted, which would override the new
        // default. This one-time flip (tracked by a flag) brings them onto the
        // new default once; the user's choice persists from then on.
        try {
            var _tabMigrated = localStorage.getItem("compSaver_defaultTab_v30");
            if (!_tabMigrated) {
                if (_getByPath(_data, "ui.defaultTab") === "templates") {
                    _setByPath(_data, "ui.defaultTab", "toolkit");
                    _persist();
                }
                localStorage.setItem("compSaver_defaultTab_v30", "1");
            }
        } catch (eMig) { }
    })();

    // ── Public API ─────────────────────────────────────────────────
    return {
        /**
         * Get a setting value by dot-notation key.
         * Falls back to defaults if the key has no stored value.
         * Never throws.
         */
        get: function (key) {
            try {
                var val = _getByPath(_data, key);
                if (val !== undefined) {
                    // Return a copy for objects/arrays to prevent mutation
                    if (val !== null && typeof val === "object") {
                        return _deepCopy(val);
                    }
                    return val;
                }
                // Fall back to defaults
                var def = _getByPath(_defaults, key);
                if (def !== undefined && def !== null && typeof def === "object") {
                    return _deepCopy(def);
                }
                return def;
            } catch (e) {
                // Never throw — return default on any failure
                try {
                    var fallback = _getByPath(_defaults, key);
                    if (fallback !== undefined && fallback !== null && typeof fallback === "object") {
                        return _deepCopy(fallback);
                    }
                    return fallback;
                } catch (ignore) {
                    return undefined;
                }
            }
        },

        /**
         * Set a setting value by dot-notation key.
         * Validates, updates _data, persists, and fires onChange.
         * Returns true if successful, false if rejected.
         */
        set: function (key, value) {
            if (!_schema[key]) {
                if (typeof console !== "undefined" && console.warn) {
                    console.warn("[Settings] Unknown key: " + key);
                }
                return false;
            }

            if (!_validate(key, value)) {
                return false;
            }

            var oldVal = _getByPath(_data, key);
            // Deep compare for objects/arrays
            var oldStr = JSON.stringify(oldVal);
            var newStr = JSON.stringify(value);
            if (oldStr === newStr) {
                return true; // No change needed, but not a failure
            }

            _setByPath(_data, key, value !== null && typeof value === "object" ? _deepCopy(value) : value);
            _persist();
            _fireListeners(key, value, oldVal);
            return true;
        },

        /**
         * Return a deep copy of the entire settings data.
         */
        getAll: function () {
            return _deepCopy(_data);
        },

        /**
         * Return a deep copy of all default values.
         */
        getDefaults: function () {
            return _deepCopy(_defaults);
        },

        /**
         * Register a listener for changes to a specific key.
         * Returns an unsubscribe function.
         */
        onChange: function (key, cb) {
            if (!_listeners[key]) {
                _listeners[key] = [];
            }
            _listeners[key].push(cb);
            // Return unsubscribe function
            return function () {
                var cbs = _listeners[key];
                if (!cbs) return;
                var idx = cbs.indexOf(cb);
                if (idx !== -1) {
                    cbs.splice(idx, 1);
                }
            };
        },

        /**
         * Remove a specific listener for a key.
         */
        offChange: function (key, cb) {
            var cbs = _listeners[key];
            if (!cbs) return;
            var idx = cbs.indexOf(cb);
            if (idx !== -1) {
                cbs.splice(idx, 1);
            }
        },

        /**
         * Reset all settings to defaults. Persists and fires all onChange.
         */
        reset: function () {
            var oldData = _deepCopy(_data);
            _data = _deepCopy(_defaults);
            _persist();

            // Fire onChange for every key that changed
            for (var key in _schema) {
                if (!_schema.hasOwnProperty(key)) continue;
                var oldVal = _getByPath(oldData, key);
                var newVal = _getByPath(_data, key);
                if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
                    _fireListeners(key, newVal, oldVal);
                }
            }
        },

        /**
         * Reset only keys under a specific section to their defaults.
         */
        resetSection: function (section) {
            if (!_defaults[section]) return;

            var oldSectionData = _deepCopy(_data[section] || {});
            _data[section] = _deepCopy(_defaults[section]);
            _persist();

            // Fire onChange for keys in this section that changed
            for (var key in _schema) {
                if (!_schema.hasOwnProperty(key)) continue;
                if (key.indexOf(section + ".") !== 0) continue;
                var oldVal = _getByPath({ section: oldSectionData }, key.replace(section + ".", "section."));
                // Simpler: re-derive from the old section data
                var subKey = key.substring(section.length + 1);
                var oldV = oldSectionData[subKey];
                var newV = _defaults[section][subKey];
                if (JSON.stringify(oldV) !== JSON.stringify(newV)) {
                    _fireListeners(key, newV, oldV);
                }
            }
        },

        /**
         * Export settings as a JSON string.
         */
        exportJSON: function () {
            return JSON.stringify(_data);
        },

        /**
         * Import settings from a JSON string.
         * Merges valid imported data, persists, fires onChange.
         * Returns { success: boolean, errors: string[] }
         */
        importJSON: function (jsonStr) {
            var errors = [];
            var imported;

            try {
                imported = JSON.parse(jsonStr);
            } catch (e) {
                return { success: false, errors: ["Invalid JSON"] };
            }

            if (imported === null || typeof imported !== "object" || Array.isArray(imported)) {
                return { success: false, errors: ["Invalid settings structure"] };
            }

            var oldData = _deepCopy(_data);

            // Iterate schema keys and merge valid values from imported data
            for (var key in _schema) {
                if (!_schema.hasOwnProperty(key)) continue;
                var importedVal = _getByPath(imported, key);
                if (importedVal === undefined) continue;

                if (_validate(key, importedVal)) {
                    _setByPath(_data, key, importedVal !== null && typeof importedVal === "object" ? _deepCopy(importedVal) : importedVal);
                } else {
                    errors.push("Invalid value for '" + key + "', skipped");
                }
            }

            _persist();

            // Fire onChange for keys that changed
            for (var k in _schema) {
                if (!_schema.hasOwnProperty(k)) continue;
                var oldVal = _getByPath(oldData, k);
                var newVal = _getByPath(_data, k);
                if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
                    _fireListeners(k, newVal, oldVal);
                }
            }

            return { success: true, errors: errors };
        }
    };

})();
