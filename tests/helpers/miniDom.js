// ============================================================
// tests/helpers/miniDom.js
// A tiny, deterministic HTML-parsing DOM used to exercise the real
// media-only keyed card adapter (js/core/keyedMediaCardHelper.js) and the real
// shared card markup (renderTemplateCardMarkup in js/templates/templates.js)
// under Jest's "node" testEnvironment.
//
// Feature: media-engine-lag
//
// Why this exists
// ---------------
// The repository pins jest 29.7.0 + fast-check 3.22.0 and adds no packages, so
// no browser DOM (jsdom) is available. The keyed adapter's contract is however
// a DOM contract: markup is produced as a string, PARSED, and the parsed
// element identity must equal `tpl-` + the Stable_Media_ID. Asserting on the
// markup string alone would not test parsing, so this harness supplies the
// missing piece: a real (small) HTML tokenizer + tree builder with browser
// attribute-entity decoding semantics.
//
// Scope: exactly the surface the adapter and the card markup touch —
// createElement / createDocumentFragment / getElementById, innerHTML parsing,
// children, appendChild / removeChild / parentNode, querySelectorAll for a
// single tag / .class / #id selector, get/set/has/removeAttribute, and the
// reflected `id` / `className` properties. Nothing here is media-specific.
// ============================================================

"use strict";

// Elements that never receive children, matching the HTML void set plus the
// self-closing SVG shapes used by the card markup.
var VOID_ELEMENTS = {
    area: true, base: true, br: true, col: true, embed: true, hr: true, img: true,
    input: true, link: true, meta: true, param: true, source: true, track: true, wbr: true,
    circle: true, ellipse: true, line: true, path: true, polygon: true, polyline: true,
    rect: true, stop: true, use: true
};

// Left-to-right single-pass decoding, exactly like an HTML attribute-value
// parser: once a reference is consumed, its replacement text is not rescanned.
// This is what makes an ID such as `&amp;` survive escape -> parse unchanged.
function decodeEntities(value) {
    return String(value).replace(
        /&(?:amp|lt|gt|quot|apos|#(\d+)|#[xX]([0-9A-Fa-f]+));/g,
        function (match, decimal, hex) {
            if (decimal !== undefined) return String.fromCharCode(parseInt(decimal, 10));
            if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
            if (match === "&amp;") return "&";
            if (match === "&lt;") return "<";
            if (match === "&gt;") return ">";
            if (match === "&quot;") return "\"";
            return "'"; // &apos;
        }
    );
}

var ATTRIBUTE_RE = /([-A-Za-z0-9_:.]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttributes(raw) {
    var attributes = [];
    var match;
    ATTRIBUTE_RE.lastIndex = 0;
    while ((match = ATTRIBUTE_RE.exec(raw)) !== null) {
        var value = match[2] !== undefined ? match[2] :
            (match[3] !== undefined ? match[3] : (match[4] !== undefined ? match[4] : ""));
        attributes.push({ name: match[1].toLowerCase(), value: decodeEntities(value) });
    }
    return attributes;
}

function MiniText(ownerDocument, data) {
    this.nodeType = 3;
    this.ownerDocument = ownerDocument;
    this.data = data;
    this.parentNode = null;
}

function MiniElement(ownerDocument, tagName) {
    this.nodeType = 1;
    this.ownerDocument = ownerDocument;
    this.tagName = String(tagName).toUpperCase();
    this.localName = String(tagName).toLowerCase();
    this.childNodes = [];
    this.parentNode = null;
    this._attributes = {};
}

MiniElement.prototype.getAttribute = function (name) {
    name = String(name).toLowerCase();
    return Object.prototype.hasOwnProperty.call(this._attributes, name) ? this._attributes[name] : null;
};

MiniElement.prototype.hasAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(this._attributes, String(name).toLowerCase());
};

MiniElement.prototype.setAttribute = function (name, value) {
    this._attributes[String(name).toLowerCase()] = value === undefined || value === null ? "" : String(value);
};

MiniElement.prototype.removeAttribute = function (name) {
    delete this._attributes[String(name).toLowerCase()];
};

Object.defineProperty(MiniElement.prototype, "id", {
    get: function () { return this.getAttribute("id") === null ? "" : this.getAttribute("id"); },
    set: function (value) { this.setAttribute("id", value); }
});

Object.defineProperty(MiniElement.prototype, "className", {
    get: function () { return this.getAttribute("class") === null ? "" : this.getAttribute("class"); },
    set: function (value) { this.setAttribute("class", value); }
});

function datasetKeyToAttribute(key) {
    return "data-" + String(key).replace(/[A-Z]/g, function (ch) { return "-" + ch.toLowerCase(); });
}

function attributeToDatasetKey(name) {
    return String(name).substring(5).replace(/-([a-z0-9])/g, function (match, ch) { return ch.toUpperCase(); });
}

// Live in both directions, read through on every access so a setAttribute can
// never leave it stale. A Proxy rather than per-key accessors because a write to
// a key with no data-* attribute yet must still reach the element's attributes.
// Non-string reads and membership probes short-circuit so Symbol probes from
// test diagnostics cannot be coerced into attribute names.
Object.defineProperty(MiniElement.prototype, "dataset", {
    get: function () {
        if (this._dataset) return this._dataset;
        var element = this;
        this._dataset = new Proxy({}, {
            get: function (ignored, key) {
                if (typeof key !== "string") return undefined;
                var value = element.getAttribute(datasetKeyToAttribute(key));
                return value === null ? undefined : value;
            },
            set: function (ignored, key, value) {
                element.setAttribute(datasetKeyToAttribute(key), value);
                return true;
            },
            has: function (ignored, key) {
                return typeof key === "string" && element.hasAttribute(datasetKeyToAttribute(key));
            },
            deleteProperty: function (ignored, key) {
                if (typeof key === "string") element.removeAttribute(datasetKeyToAttribute(key));
                return true;
            },
            ownKeys: function () {
                var keys = [];
                for (var name in element._attributes) {
                    if (!Object.prototype.hasOwnProperty.call(element._attributes, name)) continue;
                    if (name.indexOf("data-") === 0) keys.push(attributeToDatasetKey(name));
                }
                return keys;
            },
            getOwnPropertyDescriptor: function (ignored, key) {
                if (typeof key !== "string") return undefined;
                var attribute = datasetKeyToAttribute(key);
                if (!element.hasAttribute(attribute)) return undefined;
                return {
                    value: element.getAttribute(attribute),
                    writable: true,
                    enumerable: true,
                    configurable: true
                };
            }
        });
        return this._dataset;
    }
});

Object.defineProperty(MiniElement.prototype, "children", {
    get: function () {
        var result = [];
        for (var i = 0; i < this.childNodes.length; i++) {
            if (this.childNodes[i].nodeType === 1) result.push(this.childNodes[i]);
        }
        return result;
    }
});

Object.defineProperty(MiniElement.prototype, "textContent", {
    get: function () {
        var text = "";
        for (var i = 0; i < this.childNodes.length; i++) {
            var child = this.childNodes[i];
            text += child.nodeType === 3 ? child.data : child.textContent;
        }
        return text;
    }
});

function detach(node) {
    if (node.parentNode) {
        var siblings = node.parentNode.childNodes;
        var at = siblings.indexOf(node);
        if (at !== -1) siblings.splice(at, 1);
        node.parentNode = null;
    }
}

function adopt(parent, node) {
    detach(node);
    if (node.nodeType === 11) { // DocumentFragment: move its children, not itself
        var moving = node.childNodes.splice(0);
        for (var i = 0; i < moving.length; i++) {
            moving[i].parentNode = parent;
            parent.childNodes.push(moving[i]);
        }
        return node;
    }
    node.parentNode = parent;
    parent.childNodes.push(node);
    return node;
}

MiniElement.prototype.appendChild = function (node) {
    return adopt(this, node);
};

MiniElement.prototype.removeChild = function (node) {
    if (!node || node.parentNode !== this) throw new Error("removeChild: node is not a child");
    detach(node);
    return node;
};

MiniElement.prototype.contains = function (node) {
    var current = node;
    while (current) {
        if (current === this) return true;
        current = current.parentNode;
    }
    return false;
};

function matchesSelector(element, selector) {
    if (selector.charAt(0) === ".") {
        var tokens = element.className.split(/\s+/);
        return tokens.indexOf(selector.substring(1)) !== -1;
    }
    if (selector.charAt(0) === "#") return element.id === selector.substring(1);
    return element.localName === selector.toLowerCase();
}

// A comma-separated selector list, matched as "any of". The split lives here
// and NOT in matchesSelector, so getElementById — which builds "#" + id and
// calls collect directly — can never split a record id containing a comma.
function splitSelectorList(selector) {
    var raw = String(selector).split(",");
    var out = [];
    for (var i = 0; i < raw.length; i++) {
        var one = raw[i].replace(/^\s+|\s+$/g, "");
        if (one) out.push(one);
    }
    return out;
}

function matchesAny(element, selectors) {
    for (var i = 0; i < selectors.length; i++) {
        if (matchesSelector(element, selectors[i])) return true;
    }
    return false;
}

// `selectors` is an ARRAY. One traversal matching any of them, so results stay
// in document order with no duplicates — an element matching two selectors in
// the list appears once, which concatenating per-selector results would not do.
function collect(element, selectors, out) {
    for (var i = 0; i < element.childNodes.length; i++) {
        var child = element.childNodes[i];
        if (child.nodeType !== 1) continue;
        if (matchesAny(child, selectors)) out.push(child);
        collect(child, selectors, out);
    }
    return out;
}

MiniElement.prototype.querySelectorAll = function (selector) {
    return collect(this, splitSelectorList(selector), []);
};

MiniElement.prototype.querySelector = function (selector) {
    var all = this.querySelectorAll(selector);
    return all.length ? all[0] : null;
};

Object.defineProperty(MiniElement.prototype, "innerHTML", {
    get: function () { return this._innerHTML === undefined ? "" : this._innerHTML; },
    set: function (markup) {
        for (var i = 0; i < this.childNodes.length; i++) this.childNodes[i].parentNode = null;
        this.childNodes = [];
        this._innerHTML = String(markup);
        parseInto(this, this._innerHTML);
    }
});

var TAG_RE = /^<(\/?)([A-Za-z][-A-Za-z0-9:]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/;

// Stack-based tree builder. Unknown / mismatched end tags close the nearest
// matching open element, which is enough for the well-formed markup the panel
// emits while staying tolerant.
function parseInto(root, markup) {
    var stack = [root];
    var index = 0;

    while (index < markup.length) {
        if (markup.charAt(index) === "<") {
            var match = TAG_RE.exec(markup.substring(index));
            if (match) {
                var isEnd = match[1] === "/";
                var name = match[2].toLowerCase();
                index += match[0].length;

                if (isEnd) {
                    for (var depth = stack.length - 1; depth > 0; depth--) {
                        if (stack[depth].localName === name) {
                            stack.length = depth;
                            break;
                        }
                    }
                    continue;
                }

                var element = new MiniElement(root.ownerDocument, name);
                var attributes = parseAttributes(match[3]);
                for (var a = 0; a < attributes.length; a++) {
                    element.setAttribute(attributes[a].name, attributes[a].value);
                }
                stack[stack.length - 1].appendChild(element);
                if (!VOID_ELEMENTS[name] && match[4] !== "/") stack.push(element);
                continue;
            }
        }

        var next = markup.indexOf("<", index + 1);
        if (next === -1) next = markup.length;
        var text = markup.substring(index, next);
        if (text) stack[stack.length - 1].appendChild(new MiniText(root.ownerDocument, decodeEntities(text)));
        index = next;
    }
}

function MiniFragment(ownerDocument) {
    this.nodeType = 11;
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.parentNode = null;
}
MiniFragment.prototype.appendChild = MiniElement.prototype.appendChild;
MiniFragment.prototype.removeChild = MiniElement.prototype.removeChild;
Object.defineProperty(MiniFragment.prototype, "children", {
    get: Object.getOwnPropertyDescriptor(MiniElement.prototype, "children").get
});

/**
 * Create a fresh document whose `documentElement` is attached, so element
 * connectivity (`documentElement.contains(card)`) is meaningful.
 */
function createMiniDocument() {
    var document = {
        createElement: function (tagName) { return new MiniElement(document, tagName); },
        createDocumentFragment: function () { return new MiniFragment(document); },
        getElementById: function (id) {
            var found = collect(document.documentElement, ["#" + String(id)], []);
            return found.length ? found[0] : null;
        },
        querySelectorAll: function (selector) {
            return collect(document.documentElement, splitSelectorList(selector), []);
        },
        querySelector: function (selector) {
            var all = document.querySelectorAll(selector);
            return all.length ? all[0] : null;
        }
    };
    document.documentElement = new MiniElement(document, "html");
    document.body = new MiniElement(document, "body");
    document.documentElement.appendChild(document.body);
    return document;
}

/**
 * Parse a markup string in isolation and return its single root element.
 * Throws when the markup does not describe exactly one element root.
 */
function parseSingleElement(markup) {
    var document = createMiniDocument();
    var holder = document.createElement("div");
    holder.innerHTML = markup;
    var children = holder.children;
    if (children.length !== 1) {
        throw new Error("parseSingleElement: expected one root element, found " + children.length);
    }
    return children[0];
}

module.exports = {
    createMiniDocument: createMiniDocument,
    parseSingleElement: parseSingleElement,
    decodeEntities: decodeEntities,
    MiniElement: MiniElement,
    MiniFragment: MiniFragment
};
